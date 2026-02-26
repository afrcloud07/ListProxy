const tls = require("node:tls");
const cluster = require("node:cluster");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");

// --- KONFIGURASI ---
const CONFIG = {
    concurrency: 30,     // DITURUNKAN: 50 per core (Total ~200 thread jika 4 core). Lebih lambat tapi AKURAT.
    timeout: 4000,       // DINAIKKAN: 5 detik. Memberi waktu proxy lambat untuk merespons.
    batchSize: 30,       // Worker melapor ke Master setiap 50 proxy
    outputDir: 'active_proxies',
    files: {
        json: 'proxyip.json',
        txt: 'proxyip.txt',
        csv: 'proxyip.csv',
        input: 'raw.json'
    }
};

const color = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
    bgBlue: "\x1b[44m",
    gray: "\x1b[90m"
};

// --- ASIA COUNTRY CODES (ISO-3166-1 alpha-2) ---
const ASIA_COUNTRY_CODES = new Set([
    "AF","AM","AZ","BH","BD","BT","BN","KH","CN","CY","GE","HK","MO",
    "IN","ID","IR","IQ","IL","JP","JO","KZ","KW","KG","LA","LB","MY","MV",
    "MN","MM","NP","KP","KR","OM","PK","PS","PH","QA","SA","SG","LK","SY",
    "TW","TJ","TH","TL","TR","TM","AE","UZ","VN","YE"
]);

// --- HELPER FUNCTIONS ---
function formatDuration(ms) {
    if (!ms || ms < 0) return "00:00";
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function cleanOrg(org) {
    return (org || 'Unknown')
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// --- MASTER PROCESS ---
if (cluster.isPrimary) {
    const numCPUs = os.cpus().length || 4;
    const startTime = Date.now();
    const isTTY = process.stdout.isTTY;

    let stats = {
        total: 0,
        checked: 0,
        found: 0,
        speed: 0,
        activeWorkers: numCPUs
    };

    const activeProxies = [];
    const seen = new Set();
    let animationFrame = 0;
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let lastLogTime = 0;

    // FUNGSI LOGGING/UI (Dikembalikan persis seperti script pertama)
    function drawProgress() {
        const now = Date.now();
        const elapsed = (now - startTime) / 1000;
        stats.speed = Math.floor(stats.checked / elapsed) || 0;

        const pct = stats.total > 0 ? ((stats.checked / stats.total) * 100).toFixed(1) : 0;
        const remaining = stats.total - stats.checked;
        const etaSec = stats.speed > 0 ? remaining / stats.speed : 0;

        // --- MODE TTY (Tampilan Keren dengan Progress Bar) ---
        if (isTTY) {
            const width = 20;
            const filled = Math.round((width * pct) / 100);
            const barStr = color.green + '█'.repeat(filled) + color.gray + '░'.repeat(width - filled) + color.reset;
            const spin = color.cyan + spinner[animationFrame] + color.reset;

            const statusPct = `${color.bright}${pct}%${color.reset}`;
            const statusFound = `${color.gray}Found:${color.reset} ${color.green}${color.bright}${stats.found}${color.reset}`;
            const statusCheck = `${color.gray}Check:${color.reset} ${stats.checked}/${stats.total}`;
            const statusSpeed = `${color.gray}Speed:${color.reset} ${color.yellow}${stats.speed}/s${color.reset}`;
            const statusEta = `${color.gray}ETA:${color.reset} ${color.magenta}${formatDuration(etaSec * 1000)}${color.reset}`;

            const output = `\r${spin}  ${barStr}  ${statusPct}  |  ${statusFound}  |  ${statusSpeed}  |  ${statusEta}  |  ${statusCheck}`;
            process.stdout.write(output);
            animationFrame = (animationFrame + 1) % spinner.length;
        }
        // --- MODE CI (Log Sederhana agar tidak spam) ---
        else {
            if (now - lastLogTime > 5000) {
                console.log(`[PROGRESS] ${pct}% | Checked: ${stats.checked}/${stats.total} | Found: ${stats.found} | Speed: ${stats.speed}/s | ETA: ${formatDuration(etaSec * 1000)}`);
                lastLogTime = now;
            }
        }
    }

    function printFound(p) {
        // MODE SIMPLE: Tidak menampilkan log detail per IP, hanya update progress bar
        if (isTTY) {
            drawProgress(); // Paksa update UI agar counter Found langsung berubah
        }
    }

    function loadProxies() {
        if (!fs.existsSync(CONFIG.files.input)) {
            console.error(`${color.red}[ERROR] File ${CONFIG.files.input} not found!${color.reset}`);
            process.exit(1);
        }
        try {
            const content = fs.readFileSync(CONFIG.files.input, 'utf8');
            const data = JSON.parse(content);
            return [...new Set(data.map(p => `${p.proxy}:${p.port}`))];
        } catch (e) {
            console.error(`${color.red}[ERROR] Invalid JSON format in ${CONFIG.files.input}${color.reset}`);
            process.exit(1);
        }
    }

    // UPDATE: Menggunakan fetch + Referer (Sesuai script yang berfungsi)
    async function getMyIP() {
        try {
            const response = await fetch("https://speed.cloudflare.com/meta", {
                headers: { "Referer": "https://speed.cloudflare.com/" }
            });
            if (!response.ok) throw new Error("Failed");
            const data = await response.json();
            return data.clientIp;
        } catch (e) {
            // Fallback ke ipify jika gagal
            try {
                const r = await fetch("https://api.ipify.org?format=json");
                const d = await r.json();
                return d.ip;
            } catch {
                return "0.0.0.0";
            }
        }
    }

    (async () => {
        if (isTTY) process.stdout.write('\x1b[2J\x1b[0f');

        console.log(`${color.bgBlue}${color.white}${color.bright}  ⚡ PROXY CHECKER PRO (Balanced Mode)  ${color.reset}\n`);

        const myip = await getMyIP();
        const allProxies = loadProxies();
        stats.total = allProxies.length;

        console.log(`${color.dim}IP: ${myip} | Loaded: ${stats.total} proxies | Threads: ${numCPUs * CONFIG.concurrency}${color.reset}\n`);
        console.log(`Environment: ${isTTY ? 'Terminal (Interactive)' : 'CI/Background (Log Mode)'}\n`);

        const chunkSize = Math.ceil(stats.total / numCPUs);
        const updateRate = isTTY ? 100 : 1000;
        const uiInterval = setInterval(() => drawProgress(), updateRate);

        for (let i = 0; i < numCPUs; i++) {
            const worker = cluster.fork();
            const chunk = allProxies.slice(i * chunkSize, (i + 1) * chunkSize);

            worker.send({ type: 'START', myip, proxies: chunk });

            worker.on('message', (msg) => {
                if (msg.type === 'BATCH_UPDATE') {
                    stats.checked += msg.checkedCount;
                    if (msg.foundProxies && msg.foundProxies.length > 0) {
                        stats.found += msg.foundProxies.length;
                        msg.foundProxies.forEach(p => {
                            const key = `${p.proxy}:${p.port}`;
                            if (!seen.has(key)) {
                                seen.add(key);
                                activeProxies.push(p);
                                printFound(p);
                            }
                        });
                    }
                }
            });

            worker.on('exit', () => {
                stats.activeWorkers--;
                if (stats.activeWorkers === 0) {
                    clearInterval(uiInterval);
                    finish();
                }
            });
        }
    })();

    function finish() {
        if (isTTY) {
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
        }

        console.log(`\n${color.green}Scan Selesai!${color.reset}`);

        const formatProxyData = (p) => {
            const safeOrg = cleanOrg(p.asOrganization);
            return `${p.proxy},${p.port},${p.country || 'UNK'},${safeOrg}`;
        };

        try {
            // Save JSON
            fs.writeFileSync(CONFIG.files.json, JSON.stringify(activeProxies, null, 2));

            // Save TXT & CSV
            const txtContent = activeProxies.map(formatProxyData).join('\n');
            fs.writeFileSync(CONFIG.files.txt, txtContent);
            fs.writeFileSync(CONFIG.files.csv, txtContent);

            // Save per Country ( retained)
            if (!fs.existsSync(CONFIG.outputDir)) {
                fs.mkdirSync(CONFIG.outputDir, { recursive: true });
            }

            const proxiesByCountry = activeProxies.reduce((acc, p) => {
                const countryCode = (p.country || 'UNK').toUpperCase();
                if (!acc[countryCode]) acc[countryCode] = [];
                acc[countryCode].push(p);
                return acc;
            }, {});

            let filesCreated = 0;
            for (const countryCode in proxiesByCountry) {
                const filePath = path.join(CONFIG.outputDir, `${countryCode}.txt`);
                const fileContent = proxiesByCountry[countryCode].map(formatProxyData).join('\n');
                fs.writeFileSync(filePath, fileContent);
                filesCreated++;
            }

            // --- GABUNGKAN HASIL ASIA ---
            // --- GABUNGKAN HASIL ASIA ---
const asiaList = activeProxies.filter(p => {
  const cc = (p.country || "UNK").toUpperCase();
  return ASIA_COUNTRY_CODES.has(cc);
});

if (asiaList.length > 0) {

  // ✅ TEMPel DI SINI (SEBELUM asiaContent dibuat)
  const ASIA_PRIORITY = ["ID","SG","JP","MY","TH","VN","PH","KR","TW","HK","CN","IN"];
  const prio = (cc) => {
    const i = ASIA_PRIORITY.indexOf(cc);
    return i === -1 ? 999 : i;
  };

  asiaList.sort((a, b) => {
    const ca = (a.country || 'UNK').toUpperCase();
    const cb = (b.country || 'UNK').toUpperCase();
    const pa = prio(ca), pb = prio(cb);
    if (pa !== pb) return pa - pb;
    if (ca !== cb) return ca.localeCompare(cb);
    return (a.latency || 0) - (b.latency || 0);
  });

  // Baru bikin content setelah di-sort
  const asiaContent = asiaList.map(formatProxyData).join('\n');

  const asiaPath = path.join(CONFIG.outputDir, `ASIA.txt`);
  fs.writeFileSync(asiaPath, asiaContent);

  fs.writeFileSync(`proxyip_asia.txt`, asiaContent);
}

            console.log(`${color.yellow}Disimpan:${color.reset} ${stats.found} proxies`);
            if (activeProxies.length > 0) {
                console.log(`${color.yellow}Fitur Baru:${color.reset} ${filesCreated} file negara dibuat di folder ${CONFIG.outputDir}`);

                const asiaCount = asiaList.length;
                console.log(`${color.yellow}Asia:${color.reset} ${asiaCount} proxies digabung ke ${CONFIG.outputDir}/ASIA.txt (dan proxyip_asia.txt)`);
            }

        } catch (e) {
            console.error(`\n${color.red}[ERROR FILE SYSTEM] Gagal menyimpan file output!${color.reset}`);
            console.error(`${color.red}Pesan Error:${color.reset} ${e.message}`);
        }
        process.exit(0);
    }

// --- WORKER PROCESS ---
} else {
    process.on('message', async (msg) => {
        if (msg.type === 'START') {
            const { myip, proxies } = msg;
            await runWorker(myip, proxies);
            process.exit(0);
        }
    });

    async function runWorker(myip, proxies) {
        let currentIndex = 0;
        let activePromises = 0;
        let pendingChecked = 0;
        let pendingFound = [];

        // Report interval
        const reportInterval = setInterval(() => {
            if (pendingChecked > 0) {
                if (process.connected) {
                    process.send({
                        type: 'BATCH_UPDATE',
                        checkedCount: pendingChecked,
                        foundProxies: pendingFound
                    });
                }
                pendingChecked = 0;
                pendingFound = [];
            }
        }, 500);

        return new Promise((resolve) => {
            function next() {
                if (currentIndex >= proxies.length && activePromises === 0) {
                    clearInterval(reportInterval);
                    // Final report
                    if (pendingChecked > 0 && process.connected) {
                        process.send({
                            type: 'BATCH_UPDATE',
                            checkedCount: pendingChecked,
                            foundProxies: pendingFound
                        });
                    }
                    resolve();
                    return;
                }

                while (activePromises < CONFIG.concurrency && currentIndex < proxies.length) {
                    const proxyStr = proxies[currentIndex++];
                    activePromises++;

                    checkProxy(proxyStr, myip)
                        .then((result) => {
                            pendingChecked++;
                            if (result) pendingFound.push(result);
                        })
                        .finally(() => {
                            activePromises--;
                            next();
                        });
                }
            }
            next();
        });
    }

    // UPDATE: Implementasi checkProxy menggunakan logika PERSIS dari script yang berfungsi
    // Raw TLS + Referer Header + Robust Parsing
    function checkProxy(proxyStr, myip) {
        return new Promise((resolve) => {
            const [host, port] = proxyStr.split(':');
            const portNum = parseInt(port);

            if (!host || !portNum) return resolve(null);

            let socket;
            let timer;

            const done = (res) => {
                if (timer) clearTimeout(timer);
                if (socket && !socket.destroyed) socket.destroy();
                resolve(res);
            };

            timer = setTimeout(() => done(null), CONFIG.timeout);
            const startTime = Date.now();

            try {
                // Koneksi Raw TLS
                socket = tls.connect({
                    host: host,
                    port: portNum,
                    servername: 'speed.cloudflare.com',
                    rejectUnauthorized: false,
                    timeout: CONFIG.timeout
                }, () => {
                    // HEADER WAJIB: Referer
                    const request = `GET /meta HTTP/1.1\r\n` +
                        `Host: speed.cloudflare.com\r\n` +
                        `User-Agent: Mozilla/5.0\r\n` +
                        `Referer: https://speed.cloudflare.com/\r\n` +
                        `Connection: close\r\n\r\n`;
                    socket.write(request);
                });

                let data = '';
                socket.on('data', (chunk) => {
                    data += chunk.toString();
                });

                socket.on('end', () => {
                    const latency = Date.now() - startTime;
                    try {
                        // LOGIKA PARSING ROBUST
                        const parts = data.split('\r\n\r\n');
                        const body = parts.length > 1 ? parts.slice(1).join('\r\n\r\n') : parts[0];

                        if (body) {
                            let info;
                            try {
                                info = JSON.parse(body);
                            } catch (e) {
                                // Fallback jika format chunked encoding berantakan
                                const first = body.indexOf('{');
                                const last = body.lastIndexOf('}');
                                if (first !== -1 && last !== -1) {
                                    info = JSON.parse(body.substring(first, last + 1));
                                }
                            }

                            if (info && info.clientIp && info.clientIp !== myip) {
                                done({
                                    proxy: host,
                                    port: port,
                                    ip: info.clientIp,
                                    latency,
                                    country: info.country,
                                    asOrganization: info.asOrganization,
                                    city: info.city,
                                    colo: info.colo
                                });
                                return;
                            }
                        }
                    } catch (e) {
                        // Parsing gagal
                    }
                    done(null);
                });

                socket.on('error', () => done(null));
                socket.on('timeout', () => done(null));

            } catch (err) {
                done(null);
            }
        });
    }
}
