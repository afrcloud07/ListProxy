const tls = require("node:tls");
const cluster = require("node:cluster");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path"); // Tambahkan path untuk manipulasi direktori/file

// --- KONFIGURASI ---
const CONFIG = {
    concurrency: 200,    // Jumlah cek bersamaan per core
    timeout: 3500,       // Timeout dalam ms
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
        
        // --- MODE TTY (Laptop/VPS - Animasi Keren) ---
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
        // --- MODE CI (GitHub Actions - Log Sederhana) ---
        else {
            // Log hanya setiap 5 detik agar tidak membanjiri log file
            if (now - lastLogTime > 5000) {
                console.log(`[PROGRESS] ${pct}% | Checked: ${stats.checked}/${stats.total} | Found: ${stats.found} | Speed: ${stats.speed}/s | ETA: ${formatDuration(etaSec * 1000)}`);
                lastLogTime = now;
            }
        }
    }

    function printFound(p) {
        const latencyColor = p.latency < 200 ? color.green : (p.latency < 1000 ? color.yellow : color.red);
        const logMsg = `${color.cyan}[+]${color.reset} ${p.proxy}:${p.port.padEnd(5)}  ${color.magenta}${p.country}${color.reset}  ${latencyColor}${p.latency}ms${color.reset}  ${color.dim}${cleanOrg(p.asOrganization).substring(0, 20)}${color.reset}`;

        if (isTTY) {
            // Hapus baris progress, print log, gambar ulang progress
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            console.log(logMsg);
            drawProgress();
        } else {
            // Mode CI: Langsung print saja
            console.log(logMsg);
        }
    }

    // Fungsi Load Proxy
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

    async function getMyIP() {
        try {
            const res = await fetch("https://speed.cloudflare.com/meta", { signal: AbortSignal.timeout(5000) });
            const data = await res.json();
            return data.clientIp;
        } catch {
            return "0.0.0.0";
        }
    }

    (async () => {
        // Clear screen hanya jika TTY
        if (isTTY) process.stdout.write('\x1b[2J\x1b[0f');
        
        console.log(`${color.bgBlue}${color.white}${color.bright}  ⚡ PROXY CHECKER PRO  ${color.reset}\n`);

        const myip = await getMyIP();
        const allProxies = loadProxies();
        stats.total = allProxies.length;
        
        console.log(`${color.dim}IP: ${myip} | Loaded: ${stats.total} proxies | Threads: ${numCPUs * CONFIG.concurrency}${color.reset}\n`);
        console.log(`Environment: ${isTTY ? 'Terminal (Interactive)' : 'CI/Background (Log Mode)'}\n`);

        const chunkSize = Math.ceil(stats.total / numCPUs);
        
        // Interval update UI
        // Jika TTY update cepat (100ms), jika CI update lambat via drawProgress logic
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
        
        // Fungsi untuk membersihkan dan memformat data proxy
        const formatProxyData = (p) => {
            const safeOrg = cleanOrg(p.asOrganization);
            // Menggunakan format yang sama: ip,port,country,org
            return `${p.proxy},${p.port},${p.country || 'UNK'},${safeOrg}`; 
        };

        try {
            // 1. Save JSON (Output Lama)
            fs.writeFileSync(CONFIG.files.json, JSON.stringify(activeProxies, null, 2));
            
            // Content TXT/CSV (Output Lama)
            const txtContent = activeProxies.map(formatProxyData).join('\n');

            // 2. Save TXT (Output Lama)
            fs.writeFileSync(CONFIG.files.txt, txtContent);

            // 3. Save CSV (Output Lama)
            fs.writeFileSync(CONFIG.files.csv, txtContent);


            // --- FITUR BARU: Output per Negara ---

            // Buat folder output jika belum ada
            if (!fs.existsSync(CONFIG.outputDir)) {
                fs.mkdirSync(CONFIG.outputDir, { recursive: true });
                console.log(`${color.gray}Folder output dibuat: ${CONFIG.outputDir}${color.reset}`);
            }

            // Kelompokkan proxy berdasarkan negara
            const proxiesByCountry = activeProxies.reduce((acc, p) => {
                // Gunakan 'UNK' (Unknown) jika country tidak ada
                const countryCode = (p.country || 'UNK').toUpperCase(); 
                if (!acc[countryCode]) {
                    acc[countryCode] = [];
                }
                acc[countryCode].push(p);
                return acc;
            }, {});

            let filesCreated = 0;
            
            // Tulis setiap kelompok ke file terpisah
            for (const countryCode in proxiesByCountry) {
                const countryProxies = proxiesByCountry[countryCode];
                const fileContent = countryProxies.map(formatProxyData).join('\n');
                const filePath = path.join(CONFIG.outputDir, `${countryCode}.txt`);
                
                fs.writeFileSync(filePath, fileContent);
                filesCreated++;
            }

            console.log(`${color.yellow}Disimpan:${color.reset} ${stats.found} proxies`);
            
            // Tambahkan pesan jika tidak ada proxy yang ditemukan
            if (activeProxies.length === 0) {
                 console.log(`${color.red}[PERINGATAN] Tidak ada proxy aktif yang ditemukan, sehingga tidak ada file negara yang dibuat.${color.reset}`);
            } else {
                 console.log(`${color.yellow}Fitur Baru:${color.reset} ${filesCreated} file negara dibuat di folder ${CONFIG.outputDir}`);
            }

        } catch (e) {
            // Menangkap dan melaporkan kesalahan file system secara spesifik
            console.error(`\n${color.red}[ERROR FILE SYSTEM] Gagal menyimpan file output!${color.reset}`);
            console.error(`${color.red}Pesan Error:${color.reset} ${e.message}`);
            console.error(`${color.red}Cek izin (permissions) atau path direktori Anda: ${path.resolve('.')}${color.reset}`);
            
            // --- INSTRUKSI GIT BARU DITAMBAHKAN DI SINI ---
            console.log(`\n${color.cyan}================================================================${color.reset}`);
            console.log(`${color.cyan}LANGKAH BERIKUTNYA UNTUK GITHUB${color.reset}`);
            console.log(`================================================================`);
            console.log(`Jika Anda menjalankan skrip ini di CI/lokal dan ingin melihat hasilnya di GitHub,`);
            console.log(`Anda harus menambahkan dan melakukan commit file output:`);
            console.log(`\n${color.bright}$ git add ${CONFIG.outputDir}${color.reset}`);
            console.log(`${color.bright}$ git add ${CONFIG.files.json} ${CONFIG.files.txt} ${CONFIG.files.csv}${color.reset}`);
            console.log(`${color.bright}$ git commit -m "Update hasil proxy check"${color.reset}`);
            console.log(`${color.bright}$ git push${color.reset}`);
            console.log(`================================================================${color.reset}`);
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

        // Lapor ke Master setiap 500ms
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
                    if (socket) socket.destroy();
                    resolve(res);
                }
            };

            timer = setTimeout(() => done(null), CONFIG.timeout);

            const startTime = Date.now();
            
            try {
                // Menggunakan tls.connect untuk cek HTTPS
                socket = tls.connect({
                    host: host,
                    port: portNum,
                    servername: 'speed.cloudflare.com',
                    rejectUnauthorized: false,
                    timeout: CONFIG.timeout 
                }, () => {
                    // Permintaan HTTP/1.1 sederhana untuk mendapatkan metadata
                    socket.write(`GET /meta HTTP/1.1\r\nHost: speed.cloudflare.com\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`);
                });

                let data = '';
                socket.on('data', (chunk) => {
                    data += chunk.toString();
                    // Cek apakah header dan body sudah selesai (dipisahkan oleh \r\n\r\n)
                    if (data.includes('\r\n\r\n')) {
                        const latency = Date.now() - startTime;
                        try {
                            const bodyParts = data.split('\r\n\r\n');
                            const body = bodyParts.pop(); // Ambil bagian body terakhir
                            if (body) {
                                // Menghapus byte-byte chunked transfer-encoding yang mungkin ada
                                const cleanedBody = body.replace(/^[0-9a-fA-F]+\r\n/, '').replace(/\r\n[0-9a-fA-F]+\r\n$/, '');
                                const info = JSON.parse(cleanedBody);
                                
                                if (isValid(info, myip)) {
                                    const { clientIp, ...rest } = info;
                                    done({
                                        proxy: host,
                                        port: port,
                                        ip: clientIp,
                                        latency,
                                        proxyip: true,
                                        ...rest
                                    });
                                    return;
                                }
                            }
                        } catch (e) {
                            // Tangani error parsing JSON atau format tak terduga
                        }
                        done(null); // Gagal jika tidak valid atau error parsing
                    }
                });

                socket.on('error', () => done(null));
                socket.on('end', () => done(null));
                socket.on('timeout', () => done(null));

            } catch (err) {
                done(null);
            }
        });
    }

    function isValid(info, myip) {
        if (!info || !info.colo) return false;
        if (info.clientIp === myip) return false;
        return true; 
    }
}
