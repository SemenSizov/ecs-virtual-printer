const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const net = require("net");
const dgram = require("dgram");
const fs = require("fs");
const path = require("path");

let mainWindow;
const jobsDir = path.join(__dirname, "print_jobs");
if (!fs.existsSync(jobsDir)) fs.mkdirSync(jobsDir);

// for app data
// const jobsDir = path.join(app.getPath("userData"), "print_jobs");
// if (!fs.existsSync(jobsDir)) fs.mkdirSync(jobsDir, { recursive: true });

let currentFile = null;
let printerStatus = 0;

function timestampName(prefix = "") {
    const now = new Date();
    const name = now.toISOString()
        .replace(/T/, "_")
        .replace(/\..+/, "")
        .replace(/:/g, "-");
    return prefix ? `${prefix}_${name}` : name;
}

function newFile() {
    const fileName = `${timestampName()}.prn`;
    currentFile = path.join(jobsDir, fileName);
    fs.writeFileSync(currentFile, ""); // порожній файл
    if (mainWindow) mainWindow.webContents.send("new-file", fileName);
}

app.on("ready", () => {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    const { Menu } = require("electron");

    // === Custom minimal menu ===
    const template = [
        {
            label: "File",
            submenu: [
                {
                    label: "Exit",
                    accelerator: "Ctrl+Q",
                    click: () => { app.quit(); }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
    mainWindow.loadFile("index.html");


    newFile();

    // TCP 9100 (raw print)
    const printerServer = net.createServer((socket) => {
        console.log("New connection from:", socket.remoteAddress);
        socket.on("data", (data) => {
            fs.appendFileSync(currentFile, data);
            mainWindow.webContents.send("printer-data", data.toString("utf8"));
            printerStatus = 128; // printing
        });
        socket.on("end", () => {
            printerStatus = 0; // idle
        });
        socket.on("error", (err) => console.error("Socket error:", err));
    });
    printerServer.listen(9100, "0.0.0.0", () =>
        console.log("Fake printer listening on port 9100...")
    );

    // SNMP 161
    const snmpServer = dgram.createSocket("udp4");

    function encLen(n) {
        if (n < 128) return Buffer.from([n]);
        if (n < 256) return Buffer.from([0x81, n]);
        return Buffer.from([0x82, n >> 8, n & 0xff]);
    }
    function encInt(n) {
        if (n === 0) return Buffer.from([0x02, 0x01, 0x00]);
        if (n > 0 && n < 0x80) return Buffer.from([0x02, 0x01, n]);
        const hi = Math.floor(n / 256), lo = n % 256;
        return Buffer.from([0x02, 0x02, hi, lo]);
    }
    function encOctetStr(bufOrStr) {
        const b = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(bufOrStr);
        return Buffer.concat([Buffer.from([0x04]), encLen(b.length), b]);
    }
    function encOID(arr) {
        const out = [40 * arr[0] + arr[1]];
        for (let i = 2; i < arr.length; i++) {
            const v = arr[i];
            if (v < 128) out.push(v);
            else {
                const bytes = [];
                let x = v;
                bytes.unshift(x & 0x7f); x >>= 7;
                while (x > 0) { bytes.unshift((x & 0x7f) | 0x80); x >>= 7; }
                out.push(...bytes);
            }
        }
        const body = Buffer.from(out);
        return Buffer.concat([Buffer.from([0x06]), encLen(body.length), body]);
    }
    function encSeq(content, tag = 0x30) {
        return Buffer.concat([Buffer.from([tag]), encLen(content.length), content]);
    }
    function varBind(oidArr, valueBuf) {
        const oid = encOID(oidArr);
        return encSeq(Buffer.concat([oid, valueBuf]));
    }

    snmpServer.on("message", (msg, rinfo) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("snmp-ping");
        }
        try {
            let p = 0;
            if (msg[p++] !== 0x30) return;
            p += 1;
            if (msg[p++] !== 0x02) return;
            const vlen = msg[p++]; p += vlen;
            if (msg[p++] !== 0x04) return;
            const clen = msg[p++]; const community = msg.slice(p, p + clen); p += clen;
            if (msg[p] !== 0xA0) return; p++;
            p++;
            if (msg[p++] !== 0x02) return;
            const ridLen = msg[p++]; const reqIdBytes = msg.slice(p, p + ridLen); p += ridLen;

            const vb1 = varBind([1, 3, 6, 1, 2, 1, 25, 3, 2, 1, 5, 0], encInt(2));   // hrDeviceStatus.0 = running
            const vb2 = varBind([1, 3, 6, 1, 2, 1, 25, 3, 5, 1, 1, 0], encInt(2));   // hrPrinterDetectedErrorState.0
            const vb3 = varBind([1, 3, 6, 1, 2, 1, 25, 3, 5, 1, 2, 0], encInt(printerStatus)); // hrPrinterStatus.0

            const varBindList = encSeq(Buffer.concat([vb1, vb2, vb3]));
            const pduContent = Buffer.concat([
                Buffer.from([0x02, reqIdBytes.length]), reqIdBytes,
                Buffer.from([0x02, 0x01, 0x00]),
                Buffer.from([0x02, 0x01, 0x00]),
                varBindList
            ]);
            const pdu = encSeq(pduContent, 0xA2);
            const top = encSeq(Buffer.concat([
                Buffer.from([0x02, 0x01, 0x01]),
                encOctetStr(community),
                pdu
            ]));

            snmpServer.send(top, 0, top.length, rinfo.port, rinfo.address);
        } catch (e) { console.error("SNMP error:", e); }
    });
    snmpServer.bind(161, "0.0.0.0", () =>
        console.log("Fake SNMP agent running on UDP 161...")
    );
});

// IPC from Renderer
ipcMain.on("new-file", () => newFile());
ipcMain.on("print-selection", (e, text) => {
    const win = new BrowserWindow({ show: false });
    win.loadURL("data:text/plain," + encodeURIComponent(text));
    win.webContents.on("did-finish-load", () => win.webContents.print({ silent: false }));
});
ipcMain.on("save-selection", async (e, text) => {
    const { filePath, canceled } = await dialog.showSaveDialog({
        title: "Зберегти виділений текст",
        defaultPath: `${timestampName("Printer_log_selection_")}.txt`,
        filters: [{ name: "Text Files", extensions: ["txt"] }]
    });
    if (!canceled && filePath) {
        fs.writeFileSync(filePath, text, "utf8");
    }
});
ipcMain.on("print-all", () => {
    const data = fs.readFileSync(currentFile, "utf8");
    const win = new BrowserWindow({ show: false });
    win.loadURL("data:text/plain," + encodeURIComponent(data));
    win.webContents.on("did-finish-load", () => win.webContents.print({ silent: false }));
});
ipcMain.on("save-all", async () => {
    const data = fs.readFileSync(currentFile, "utf8");
    const { filePath, canceled } = await dialog.showSaveDialog({
        title: "Зберегти весь текст",
        defaultPath: `${timestampName("Printer_log_")}.txt`,
        filters: [{ name: "Text Files", extensions: ["txt"] }]
    });
    if (!canceled && filePath) {
        fs.writeFileSync(filePath, data, "utf8");
    }
});

// History
ipcMain.on("get-history", (e) => {
    const files = fs.readdirSync(jobsDir)
        .filter(f => f.endsWith(".prn"))
        .map(f => ({ name: f, path: path.join(jobsDir, f) }))
        .sort((a, b) => b.name.localeCompare(a.name));
    e.sender.send("history-list", files);
});

ipcMain.on("load-history-file", (e, filePath) => {
    try {
        const content = fs.readFileSync(filePath, "utf8");
        e.sender.send("history-file", { filePath, content });
    } catch (err) {
        e.sender.send("history-file", { filePath, content: "Error loading file" });
    }
});

ipcMain.on("print-history-file", (e, filePath) => {
    try {
        const data = fs.readFileSync(filePath, "utf8");
        const win = new BrowserWindow({ show: false });
        win.loadURL("data:text/plain," + encodeURIComponent(data));
        win.webContents.on("did-finish-load", () => {
            win.webContents.print({ silent: false });
        });
    } catch (err) {
        console.error("Print history error:", err);
    }
});

ipcMain.on("save-history-file", async (e, filePath) => {
    try {
        const data = fs.readFileSync(filePath, "utf8");
        const { filePath: outPath, canceled } = await dialog.showSaveDialog({
            title: "Save history file as",
            defaultPath: `${timestampName()}.txt`,
            filters: [{ name: "Text Files", extensions: ["txt"] }]
        });
        if (!canceled && outPath) {
            fs.writeFileSync(outPath, data, "utf8");
        }
    } catch (err) {
        console.error("Save history error:", err);
    }
});
