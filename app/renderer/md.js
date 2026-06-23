/* Tiny markdown renderer for agent bubbles.
 *
 * Intentionally small — supports just the formats Claude leans on:
 *   - Fenced code blocks (``` … ```) with a copy button
 *   - Inline `code`
 *   - **bold**, *italic*
 *   - Tables (| col | col | with --- separator row)
 *   - Bullet lists (-, *) and numbered lists (1.)
 *   - Headers (##, ###)
 *   - Blockquotes (> …)
 *   - Links [text](url)
 *
 * Every output snippet is HTML-escaped first; only the parser's own
 * tags survive. No raw user HTML is ever injected.
 */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderInline(raw) {
  let s = escapeHtml(raw);
  // links [text](url) — drop javascript: schemes defensively.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    if (/^\s*javascript:/i.test(url)) return text;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  // inline code
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
  // **bold**, then *italic* (avoid eating bold's asterisks).
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return addColorSwatches(s);
}

/* CSS color literals: hex (#rgb/#rgba/#rrggbb/#rrggbbaa) and rgb()/rgba().
 * The character class is deliberately tight so a matched value is always safe
 * to drop into a CSS custom property (no quotes, semicolons, or angle brackets). */
const COLOR_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|rgba?\(\s*[\d.\s,/%]+\)/g;

/* Append a small color swatch after every color literal so the actual color is
 * visible next to its value. Operates only on text segments — HTML tags (and
 * their attributes, e.g. link hrefs) are left untouched. */
function addColorSwatches(html) {
  return html.replace(/(<[^>]+>)|([^<]+)/g, (m, tag, text) =>
    tag ? tag : text.replace(COLOR_RE, (c) => `${c}<span class="md-swatch" style="--swatch:${c}"></span>`)
  );
}

function isTableRow(line) { return /^\s*\|.*\|\s*$/.test(line); }
function isTableSeparator(line) { return /^\s*\|?\s*:?-{2,}/.test(line) && line.includes('|'); }

function parseTableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

export function renderMarkdown(input) {
  const src = String(input || '');
  if (!src) return '';
  const out = [];
  const lines = src.replace(/\r\n?/g, '\n').split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code blocks ```lang … ```
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { codeLines.push(lines[i]); i++; }
      i++; // closing ``` (or EOF)
      const code = escapeHtml(codeLines.join('\n'));
      out.push(
        `<div class="md-code"><button type="button" class="md-code-copy" data-action="copy" aria-label="Copy code">Copy</button>` +
        `<pre><code${lang ? ` class="lang-${lang}"` : ''}>${code}</code></pre></div>`
      );
      continue;
    }

    // Tables: row + separator + rows
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const head = parseTableCells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(parseTableCells(lines[i]));
        i++;
      }
      out.push(
        '<table class="md-table"><thead><tr>' +
        head.map(c => `<th>${renderInline(c)}</th>`).join('') +
        '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => `<td>${renderInline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>'
      );
      continue;
    }

    // Headers
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(6, h[1].length);
      out.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote (single line; multi-line quotes collapse)
    if (/^>\s/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderInline(quoted.join(' '))}</blockquote>`);
      continue;
    }

    // Bullet list (-, *, +)
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      out.push('<ul>' + items.map(t => `<li>${renderInline(t)}</li>`).join('') + '</ul>');
      continue;
    }

    // Numbered list (1.  2.  …)
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push('<ol>' + items.map(t => `<li>${renderInline(t)}</li>`).join('') + '</ol>');
      continue;
    }

    // Blank line → paragraph break
    if (line.trim() === '') { i++; continue; }

    // Paragraph: collect contiguous non-block lines
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' &&
           !lines[i].match(/^```/) &&
           !lines[i].match(/^#{1,6}\s+/) &&
           !/^\s*[-*+]\s+/.test(lines[i]) &&
           !/^\s*\d+\.\s+/.test(lines[i]) &&
           !/^>\s/.test(lines[i]) &&
           !isTableRow(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(para.join(' '))}</p>`);
  }

  return out.join('');
}

/* Wire up "Copy" buttons on code blocks rendered inside `root`. Call
 * after innerHTML assignment. */
export function attachCodeCopyHandlers(root) {
  for (const btn of root.querySelectorAll('.md-code-copy')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const code = btn.parentElement?.querySelector('pre code')?.textContent || '';
      navigator.clipboard?.writeText(code);
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1200);
    });
  }
}
