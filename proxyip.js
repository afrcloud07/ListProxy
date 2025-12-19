const tls = require("node:tls");
const cluster = require("node:cluster");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");

// --- KONFIGURASI ---
const CONFIG = {
    concurrency: 200,    // Jumlah cek bersamaan per core
    timeout: 5000,       // Timeout sedikit dinaikkan untuk TLS Handshake
    batchSize: 50,       // Worker melapor ke Master setiap 50 proxy
    outputDir: 'active_proxies', // Folder output baru
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
    
    // Deteksi apakah berjalan di Terminal Interaktif atau GitHub Actions (CI)
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

    // FUNGSI GAMBAR UI (ADAPTIF)
    function drawProgress() {
        const now = Date.now();
        const elapsed = (now - startTime) / 1000;
        stats.speed = Math.floor(stats.checked / elapsed) || 0;
        
        const pct = stats.total > 0 ? ((stats.checked / stats.total) * 100).toFixed(1) : 0;
        const remaining = stats.total - stats.checked;
        const etaSec = stats.speed > 0 ? remaining / stats.speed : 0;
        
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
        } else {
            if (now - lastLogTime > 5000) {
                console.log(`[PROGRESS] ${pct}% | Checked: ${stats.checked}/${stats.total} | Found: ${stats.found} | Speed: ${stats.speed}/s | ETA: ${formatDuration(etaSec * 1000)}`);
                lastLogTime = now;
            }
        }
    }

    function printFound(p) {
        const latencyColor = p.latency < 200 ? color.green : (p.latency < 1000 ? color.yellow : color.red);
        // Sekarang kita punya data asOrganization dari endpoint /meta
        const orgInfo = p.asOrganization ? cleanOrg(p.asOrganization).substring(0, 20) : "Unknown Org";
        const logMsg = `${color.cyan}[+]${color.reset} ${p.proxy}:${p.port.padEnd(5)}  ${color.magenta}${p.country}${color.reset}  ${latencyColor}${p.latency}ms${color.reset}  ${color.dim}${orgInfo}${color.reset}`;

        if (isTTY) {
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            console.log(logMsg);
            drawProgress();
        } else {
            console.log(logMsg);
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

    // UPDATE: Menggunakan /cdn-cgi/trace untuk getMyIP agar lebih stabil (menghindari "IP: undefined")
    async function getMyIP() {
        return new Promise((resolve) => {
            const socket = tls.connect({
                host: '1.1.1.1',
                port: 443,
                servername: 'one.one.one.one',
                rejectUnauthorized: false
            }, () => {
                socket.write(`GET /cdn-cgi/trace HTTP/1.1\r\nHost: one.one.one.one\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`);
            });

            let data = '';
            socket.on('data', chunk => data += chunk.toString());
            
            socket.on('end', () => {
                // Parsing ip=... dari trace
                const match = data.match(/ip=(.+)/);
                if (match && match[1]) {
                    resolve(match[1].trim());
                } else {
                    resolve("0.0.0.0");
                }
            });

            socket.on('error', () => resolve("0.0.0.0"));
            socket.setTimeout(5000, () => {
                socket.destroy();
                resolve("0.0.0.0");
            });
        });
    }

    (async () => {
        if (isTTY) process.stdout.write('\x1b[2J\x1b[0f');
        
        console.log(`${color.bgBlue}${color.white}${color.bright}  ⚡ PROXY CHECKER PRO (Meta Mode)  ${color.reset}\n`);

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
            fs.writeFileSync(CONFIG.files.json, JSON.stringify(activeProxies, null, 2));
            const txtContent = activeProxies.map(formatProxyData).join('\n');
            fs.writeFileSync(CONFIG.files.txt, txtContent);
            fs.writeFileSync(CONFIG.files.csv, txtContent);

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

            console.log(`${color.yellow}Disimpan:${color.reset} ${stats.found} proxies`);
            if (activeProxies.length > 0) {
                 console.log(`${color.yellow}Fitur Baru:${color.reset} ${filesCreated} file negara dibuat di folder ${CONFIG.outputDir}`);
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

    // UPDATE: Implementasi cek proxy menggunakan Raw TLS ke speed.cloudflare.com/meta
    function checkProxy(proxyStr, myip) {
        return new Promise((resolve) => {
            const [host, port] = proxyStr.split(':');
            const portNum = parseInt(port);

            if (!host || !portNum) return resolve(null);

            let socket;
            let timer;
            let hasResolved = false;

            const done = (res) => {
                if (!hasResolved) {
                    hasResolved = true;
                    if (timer) clearTimeout(timer);
                    if (socket && !socket.destroyed) socket.destroy();
                    resolve(res);
                }
            };

            timer = setTimeout(() => done(null), CONFIG.timeout);
            const startTime = Date.now();
            
            try {
                // Koneksi Raw TLS ke Proxy (seperti di script Express)
                socket = tls.connect({
                    host: host, // Connect ke Proxy IP
                    port: portNum, // Connect ke Proxy Port
                    servername: 'speed.cloudflare.com', // SNI target
                    rejectUnauthorized: false, // Abaikan validasi SSL proxy
                    timeout: CONFIG.timeout 
                }, () => {
                    // Manual HTTP Request String
                    // UPDATE: Menambahkan Header Accept agar Cloudflare lebih bersahabat dan return JSON
                    const request = `GET /meta HTTP/1.1\r\n` +
                                    `Host: speed.cloudflare.com\r\n` +
                                    `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n` +
                                    `Accept: application/json,text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8\r\n` +
                                    `Accept-Language: en-US,en;q=0.5\r\n` +
                                    `Connection: close\r\n\r\n`;
                    socket.write(request);
                });

                let responseBody = '';
                socket.on('data', (data) => {
                    responseBody += data.toString();
                });

                socket.on('end', () => {
                    const latency = Date.now() - startTime;
                    try {
                        // Pisahkan Header dan Body
                        const parts = responseBody.split('\r\n\r\n');
                        const body = parts.length > 1 ? parts[1] : parts[0];
                        
                        if (body && body.trim().startsWith('{')) {
                            const info = JSON.parse(body);
                            
                            // Validasi: IP harus ada dan berbeda dengan IP asli server
                            // Note: myip bisa saja 0.0.0.0 jika getMyIP gagal, tapi setidaknya info.clientIp harus ada
                            if (info && info.clientIp && info.clientIp !== myip) {
                                done({
                                    proxy: host,
                                    port: port,
                                    ip: info.clientIp,
                                    latency,
                                    country: info.country,
                                    asOrganization: info.asOrganization, // Mengambil nama ISP
                                    city: info.city,
                                    colo: info.colo
                                });
                                return;
                            }
                        }
                    } catch (e) {
                        // JSON Parse error atau format tidak sesuai
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
