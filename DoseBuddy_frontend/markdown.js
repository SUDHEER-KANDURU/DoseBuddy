// Lightweight, dependency-free Markdown rendering for the AI chat.
//
// Safety model: escapeHtml() converts &, <, >, " to HTML entities. renderMarkdown()
// escapes the ENTIRE input up front, then applies block/inline Markdown formatting to
// the already-escaped text. Because escaping only touches & < > " (and never the
// Markdown tokens ** * ` # | - or digits), the parser still recognizes Markdown while
// no raw AI/user HTML can ever reach the DOM.
//
// This module is the single source of truth: app.js imports these functions and tests
// import the exact same code.

export function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export function renderMarkdown(text) {
    if (!text) return "";

    // Escape first so no raw HTML survives; Markdown tokens remain intact.
    const lines = escapeHtml(text).split("\n");
    let html = "";
    let i = 0;
    let inList = false;
    let inOrderedList = false;
    let inTable = false;
    let tableRows = [];

    function flushList() {
        if (inList) { html += "</ul>"; inList = false; }
        if (inOrderedList) { html += "</ol>"; inOrderedList = false; }
    }

    function flushTable() {
        if (!inTable) return;
        inTable = false;
        if (tableRows.length < 2) { tableRows = []; return; }
        html += '<div class="ai-table-wrap"><table class="ai-table">';
        tableRows.forEach((row, idx) => {
            const tag = idx === 0 ? "th" : "td";
            const cells = row.split("|").map(c => c.trim()).filter((c, ci, arr) => ci > 0 && ci < arr.length - 1);
            if (idx === 1 && cells.every(c => /^[-: ]+$/.test(c))) return; // skip separator row
            html += "<tr>" + cells.map(c => `<${tag}>${inlineFormat(c)}</${tag}>`).join("") + "</tr>";
        });
        html += "</table></div>";
        tableRows = [];
    }

    function inlineFormat(str) {
        return str
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            .replace(/\*(.+?)\*/g, "<em>$1</em>")
            .replace(/`(.+?)`/g, "<code>$1</code>");
    }

    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();

        // Table row
        if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
            flushList();
            inTable = true;
            tableRows.push(trimmed);
            i++; continue;
        } else if (inTable) {
            flushTable();
        }

        // Headings
        const hMatch = trimmed.match(/^(#{1,4})\s+(.+)/);
        if (hMatch) {
            flushList();
            const level = Math.min(hMatch[1].length + 1, 4);
            html += `<h${level} class="ai-h${level}">${inlineFormat(hMatch[2])}</h${level}>`;
            i++; continue;
        }

        // Horizontal rule
        if (/^[-*_]{3,}$/.test(trimmed)) {
            flushList(); html += "<hr class='ai-hr'>"; i++; continue;
        }

        // Unordered list
        const ulMatch = trimmed.match(/^[-*•]\s+(.+)/);
        if (ulMatch) {
            if (!inList) { flushList(); html += '<ul class="ai-ul">'; inList = true; }
            html += `<li>${inlineFormat(ulMatch[1])}</li>`;
            i++; continue;
        }

        // Ordered list
        const olMatch = trimmed.match(/^\d+\.\s+(.+)/);
        if (olMatch) {
            if (!inOrderedList) { flushList(); html += '<ol class="ai-ol">'; inOrderedList = true; }
            html += `<li>${inlineFormat(olMatch[1])}</li>`;
            i++; continue;
        }

        // Empty line — close open blocks
        if (!trimmed) {
            flushList();
            i++; continue;
        }

        // Bold-only line (acts as a section heading)
        const boldLine = trimmed.match(/^\*\*(.+)\*\*:?$/);
        if (boldLine) {
            flushList();
            html += `<p class="ai-bold-heading">${inlineFormat(trimmed)}</p>`;
            i++; continue;
        }

        // Normal paragraph
        flushList();
        html += `<p class="ai-p">${inlineFormat(trimmed)}</p>`;
        i++;
    }

    flushList();
    flushTable();

    return `<div class="ai-response-body">${html}</div>`;
}
