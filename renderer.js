const { ipcRenderer } = require("electron");

const log = document.getElementById("log");
const historyList = document.getElementById("file-list");
const historyContent = document.getElementById("history-content");

let currentHistoryFile = null;
let searchState = {
    current: { matches: [], index: -1 },
    history: { matches: [], index: -1 }
};

// === Current session ===
ipcRenderer.on("printer-data", (e, data) => {
    const raw = (log.dataset.raw || log.textContent) + data;
    log.dataset.raw = raw;

    const term = document.getElementById("search-current").value;
    if (term) {
        highlightText(log, term, "current");
    } else {
        log.textContent += data;
        log.scrollTop = log.scrollHeight; // автоскрол вниз
    }
});

ipcRenderer.on("new-file", (e, name) => {
    log.textContent = "";
    log.dataset.raw = "";
    searchState.current = { matches: [], index: -1 };
    updateCounter("current");
    console.log("Started new file:", name);
});

// === History ===
ipcRenderer.on("history-list", (e, files) => {
    historyList.innerHTML = "";
    files.forEach(f => {
        const div = document.createElement("div");
        div.className = "file-item";

        let displayName = f.name.replace(".prn", "");
        displayName = displayName.replace("_", " ");
        displayName = displayName.replace(/-/g, (m, i) =>
            i > displayName.indexOf(" ") ? ":" : "-"
        );

        div.textContent = displayName;
        div.title = f.name;
        div.onclick = () => {
            document.querySelectorAll(".file-item").forEach(el => el.classList.remove("active"));
            div.classList.add("active");
            ipcRenderer.send("load-history-file", f.path);
        };
        historyList.appendChild(div);
    });
});

ipcRenderer.on("history-file", (e, { filePath, content }) => {
    currentHistoryFile = filePath;
    historyContent.textContent = content;
    historyContent.dataset.raw = content;
    searchState.history = { matches: [], index: -1 };
    updateCounter("history");
});

// === Tab switch ===
function showTab(id) {
    document.getElementById("log").style.display = (id === "current") ? "block" : "none";
    document.getElementById("history-content").style.display = (id === "history") ? "block" : "none";

    document.getElementById("tab-current").classList.toggle("active", id === "current");
    document.getElementById("tab-history").classList.toggle("active", id === "history");

    // Дії
    document.getElementById("actions-current").style.display = (id === "current") ? "block" : "none";
    document.getElementById("actions-history").style.display = (id === "history") ? "block" : "none";

    // Пошук
    document.getElementById("search-current").style.display = (id === "current") ? "block" : "none";
    document.getElementById("search-current-controls").style.display = (id === "current") ? "block" : "none";

    document.getElementById("search-box").style.display = (id === "history") ? "block" : "none";
    document.getElementById("search-history-controls").style.display = (id === "history") ? "block" : "none";

    // Список файлів
    document.getElementById("file-list").style.display = (id === "history") ? "block" : "none";

    if (id === "history") {
        ipcRenderer.send("get-history");
    }
}


// === Actions ===
function newFile() { ipcRenderer.send("new-file"); }

function printSelection() {
    const sel = window.getSelection().toString();
    if (sel) ipcRenderer.send("print-selection", sel);
}

function saveSelection() {
    const sel = window.getSelection().toString();
    if (sel) ipcRenderer.send("save-selection", sel);
}

function printAll() { ipcRenderer.send("print-all"); }
function saveAll() { ipcRenderer.send("save-all"); }

function printHistory() {
    if (currentHistoryFile) ipcRenderer.send("print-history-file", currentHistoryFile);
}

function saveHistory() {
    if (currentHistoryFile) ipcRenderer.send("save-history-file", currentHistoryFile);
}

// === Search / Highlight with counter ===
function highlightText(container, term, mode) {
    const raw = container.dataset.raw || container.textContent;
    container.dataset.raw = raw;

    if (!term) {
        container.textContent = raw;
        searchState[mode] = { matches: [], index: -1 };
        updateCounter(mode);
        return;
    }

    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(${escaped})`, "gi");

    container.innerHTML = raw.replace(regex, `<mark>$1</mark>`);
    const marks = Array.from(container.querySelectorAll("mark"));
    searchState[mode] = { matches: marks, index: marks.length ? 0 : -1 };

    if (marks.length) {
        marks[0].classList.add("active-mark");
        marks[0].scrollIntoView({ behavior: "smooth", block: "center" });
    }
    updateCounter(mode);
}

function updateCounter(mode) {
    const state = searchState[mode];
    const counterEl = document.getElementById(`counter-${mode}`);
    if (!state.matches.length) {
        counterEl.textContent = "";
        return;
    }
    const current = state.index >= 0 ? state.index + 1 : 0;
    counterEl.textContent = `${current}/${state.matches.length}`;
}

function nextMatch(mode) {
    const state = searchState[mode];
    if (!state.matches.length) return;

    if (state.index >= 0) state.matches[state.index].classList.remove("active-mark");
    state.index = (state.index + 1) % state.matches.length;
    state.matches[state.index].classList.add("active-mark");
    state.matches[state.index].scrollIntoView({ behavior: "smooth", block: "center" });
    updateCounter(mode);
}

function prevMatch(mode) {
    const state = searchState[mode];
    if (!state.matches.length) return;

    if (state.index >= 0) state.matches[state.index].classList.remove("active-mark");
    state.index = (state.index - 1 + state.matches.length) % state.matches.length;
    state.matches[state.index].classList.add("active-mark");
    state.matches[state.index].scrollIntoView({ behavior: "smooth", block: "center" });
    updateCounter(mode);
}

// === Wire search inputs ===
function searchInCurrent() {
    const term = document.getElementById("search-current").value;
    highlightText(log, term, "current");
}

function searchInHistory() {
    const term = document.getElementById("search-box").value;
    highlightText(historyContent, term, "history");
}

window.showTab = showTab;
window.newFile = newFile;
window.printSelection = printSelection;
window.saveSelection = saveSelection;
window.printAll = printAll;
window.saveAll = saveAll;
window.printHistory = printHistory;
window.saveHistory = saveHistory;
window.prevMatch = prevMatch;
window.nextMatch = nextMatch;
window.searchInCurrent = searchInCurrent;
window.searchInHistory = searchInHistory;
