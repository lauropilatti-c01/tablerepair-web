/**
 * AUDIT SERVICE - Migrado para Node.js
 *
 * IMPORTANTE: Este arquivo preserva 100% da lógica original.
 * Única mudança: DOMParser → jsdom para funcionar em Node.js
 *
 * NÃO ALTERAR a lógica de detecção sem aprovação explícita!
 */

import { JSDOM } from 'jsdom';
import { performance } from 'perf_hooks';
import type { Issue, AuditReport, Question } from '../utils/types.js';

// ============================================================================
// CONSTANTS & REGEX (PRESERVADO DO ORIGINAL)
// ============================================================================

export const FIELDS_TO_AUDIT = ['enunciado', 'resolucao', 'resolucao_aprofundada', 'texto_associado'] as const;

const REGEX_SPLIT_CELL = /^(\s*\$\s*|\s*[A-Za-z]_\{?\d+\}?\s*)$/;
const REGEX_SPLIT_OPERATOR = /^[\s]*[><=+*/][\s]*$/;
const REGEX_AI_LAZY = /\[.*(incompleta|fórmula|formula|missing|erro|check|todo|inserir|preencher).*\]/i;
const REGEX_BROKEN_ENTITY = /&[a-zA-Z]+(?![a-zA-Z;])|&#\d*(?![0-9;])/;
const REGEX_MD_TABLE = /(^\s*\|.+\|\s*$)\s*\n\s*\|[\s:-]+\|\s*$/m;
const REGEX_HYPHEN_ONLY = /^[\s\u00A0]*[-–—]+[\s\u00A0]*$/;
const REGEX_CONTENT_SWALLOW = /Armadilha\s*#\d+|Estratégia\s*#\d+|Critérios para Classificação de Sigilo|mnemonica-box/i;
const REGEX_BROKEN_STYLE_VALUE = /style\s*=\s*["'][^"']*&[lg]t;/i;

// ============================================================================
// HELPERS (PRESERVADO DO ORIGINAL)
// ============================================================================

const uid = (): string => Math.random().toString(36).slice(2, 11);

export const getQuestionId = (q: Question): string | number => {
  if (q.id != null && q.id !== '') return q.id;
  if (q.id_pasta != null && q.id_pasta !== '') return q.id_pasta;
  if (q.id_resolucao != null && q.id_resolucao !== '') return q.id_resolucao;
  return 'UNKNOWN';
};

const createIssue = (
  context: { qid: string | number; questionIndex: number; field: string; tableIndex: number; fullText: string },
  severity: 'BAD' | 'WARN',
  type: string,
  title: string,
  location: { row?: number; col?: number },
  rawHtml: string
): Issue => ({
  id: uid(),
  qid: context.qid,
  questionIndex: context.questionIndex,
  field: context.field,
  tableIndex: context.tableIndex,
  severity,
  type,
  title,
  location,
  rawHtml,
  fullText: context.fullText
});

const cellHasContent = (cell: Element): boolean => {
  const text = (cell.textContent ?? '').trim();
  if (text !== '') return true;
  if (cell.querySelector('img, svg, canvas, video, audio, iframe, math')) return true;
  const html = (cell as any).innerHTML ?? '';
  if (/<br\s*\/?>/i.test(html)) return true;
  return false;
};

const safeInt = (v: string | null, fallback = 1): number => {
  const n = parseInt(v ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
};

const getText = (el: Element | null): string => (el?.textContent ?? '').trim();

const checkLatexBalance = (text: string): { broken: boolean; reason: string } => {
  const trimmed = text.trim();

  if (trimmed.length < 3) {
    return { broken: false, reason: '' };
  }

  if (/^[RU]?\$\s*[\d.,]/.test(trimmed) || /R\$/.test(trimmed)) {
    return { broken: false, reason: '' };
  }

  if (trimmed === '{' || trimmed === '}' || trimmed === '$' || trimmed === '($' || trimmed === '$)') {
    return { broken: true, reason: 'Orphan symbol' };
  }

  if (/^\$[^$]*\\[a-zA-Z]/.test(trimmed) && (trimmed.match(/\$/g) || []).length === 1) {
    return { broken: true, reason: 'Starts with $ but unclosed' };
  }

  if (/\\(frac|sqrt|vec|sum|int|prod|alpha|beta|gamma|delta|sigma|omega|theta|phi|text)\{/.test(trimmed)) {
    if (!trimmed.includes('$')) {
      return { broken: true, reason: 'LaTeX command without $' };
    }
  }

  return { broken: false, reason: '' };
};

// ADAPTADO: Usar jsdom em vez de DOMParser
const extractTopLevelTables = (html: string): Element[] => {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const all = Array.from(doc.querySelectorAll('table'));
  if (all.length === 0) return [];

  return all.filter(t => {
    let p = t.parentElement;
    while (p) {
      if (p.tagName === 'TABLE') return false;
      p = p.parentElement;
    }
    return true;
  });
};

// ============================================================================
// GRID BUILDER (PRESERVADO DO ORIGINAL)
// ============================================================================

type GridCell = {
  el: Element;
  row: number;
  col: number;
  colspan: number;
  rowspan: number;
};

type TableGrid = {
  expectedCols: number;
  headerCells: GridCell[];
  bodyCells: GridCell[];
  rowWidths: number[];
  colHasContent: boolean[];
};

const computeExpectedColsFromHeader = (headerCells: Element[]): number => {
  if (headerCells.length === 0) return 0;
  return headerCells.reduce((acc, c) => acc + safeInt(c.getAttribute('colspan'), 1), 0);
};

const buildGrid = (headerRowEl: Element | null, bodyRowEls: Element[]): TableGrid => {
  const headerRowCellsEls = headerRowEl ? Array.from(headerRowEl.querySelectorAll('th, td')) : [];
  const expectedCols = computeExpectedColsFromHeader(headerRowCellsEls);

  const pendingRowspans: number[] = [];
  const rowWidths: number[] = new Array(bodyRowEls.length).fill(0);

  const headerCells: GridCell[] = [];
  const bodyCells: GridCell[] = [];

  if (headerRowEl) {
    let col = 0;
    for (const cell of headerRowCellsEls) {
      const colspan = safeInt(cell.getAttribute('colspan'), 1);
      const rowspan = safeInt(cell.getAttribute('rowspan'), 1);
      headerCells.push({ el: cell, row: -1, col, colspan, rowspan });
      col += colspan;
    }
  }

  const nextFreeCol = (startCol: number): number => {
    let c = startCol;
    while (pendingRowspans[c] && pendingRowspans[c] > 0) c++;
    return c;
  };

  const computeRowWidth = (placedRightEdge: number): number => {
    let right = placedRightEdge;
    for (let c = 0; c < pendingRowspans.length; c++) {
      if (pendingRowspans[c] && pendingRowspans[c] > 0) {
        if (c + 1 > right) right = c + 1;
      }
    }
    return right;
  };

  const colHasContent: boolean[] = new Array(Math.max(expectedCols, 1)).fill(false);

  bodyRowEls.forEach((tr, rIdx) => {
    const cells = Array.from(tr.querySelectorAll('td, th'));

    let col = 0;
    let placedRightEdge = 0;

    for (const cell of cells) {
      col = nextFreeCol(col);

      const colspan = safeInt(cell.getAttribute('colspan'), 1);
      const rowspan = safeInt(cell.getAttribute('rowspan'), 1);

      bodyCells.push({ el: cell, row: rIdx, col, colspan, rowspan });

      if (cellHasContent(cell)) {
        const needed = col + colspan;
        if (needed > colHasContent.length) {
          colHasContent.length = needed;
          for (let i = 0; i < colHasContent.length; i++) {
            if (typeof colHasContent[i] !== 'boolean') colHasContent[i] = false;
          }
        }
        for (let i = 0; i < colspan; i++) {
          colHasContent[col + i] = true;
        }
      }

      if (rowspan > 1) {
        for (let i = 0; i < colspan; i++) {
          const c = col + i;
          pendingRowspans[c] = Math.max(pendingRowspans[c] || 0, rowspan - 1);
        }
      }

      col += colspan;
      placedRightEdge = Math.max(placedRightEdge, col);
    }

    rowWidths[rIdx] = computeRowWidth(placedRightEdge);

    for (let c = 0; c < pendingRowspans.length; c++) {
      if (pendingRowspans[c] && pendingRowspans[c] > 0) pendingRowspans[c] -= 1;
      if (pendingRowspans[c] === 0) pendingRowspans[c] = 0;
    }
  });

  const derivedExpected = expectedCols > 0 ? expectedCols : Math.max(0, ...rowWidths);

  const finalWidth = Math.max(derivedExpected, colHasContent.length);
  const normalizedColHasContent = new Array(finalWidth).fill(false);
  for (let i = 0; i < Math.min(finalWidth, colHasContent.length); i++) {
    normalizedColHasContent[i] = !!colHasContent[i];
  }

  return {
    expectedCols: derivedExpected,
    headerCells,
    bodyCells,
    rowWidths,
    colHasContent: normalizedColHasContent
  };
};

// ============================================================================
// MAIN AUDIT (PRESERVADO DO ORIGINAL)
// ============================================================================

export const auditData = (data: Question[] | { questoes: Question[] }): AuditReport => {
  const start = performance.now();
  const allIssues: Issue[] = [];
  let tableCount = 0;

  const questions = Array.isArray(data) ? data : (data.questoes || []);

  questions.forEach((q, index) => {
    const qid = getQuestionId(q);

    FIELDS_TO_AUDIT.forEach(field => {
      if (field === ('resolucao_original' as any)) return;

      const value = q[field];
      if (!value || typeof value !== 'string') return;

      if (REGEX_MD_TABLE.test(value) && !/<table/i.test(value)) {
        allIssues.push(createIssue(
          { qid: qid, questionIndex: index, field, tableIndex: 0, fullText: value },
          'BAD',
          'MARKDOWN_TABLE_IN_FIELD',
          'Field contains Markdown table instead of HTML',
          {},
          value.slice(0, 600)
        ));
      }

      const topTables = extractTopLevelTables(value);
      if (topTables.length === 0) return;

      topTables.forEach((tableEl, idx) => {
        tableCount++;
        const html = (tableEl as any).outerHTML;
        const issues = analyzeTable(html, {
          qid: qid,
          questionIndex: index,
          field,
          tableIndex: idx,
          fullText: value
        });
        if (issues.length) allIssues.push(...issues);
      });
    });
  });

  return {
    stats: {
      time: Math.round(performance.now() - start),
      totalTables: tableCount,
      bad: allIssues.filter(i => i.severity === 'BAD').length,
      warn: allIssues.filter(i => i.severity === 'WARN').length
    },
    issues: allIssues
  };
};

// ============================================================================
// TABLE ANALYSIS (PRESERVADO DO ORIGINAL)
// ============================================================================

export const analyzeTable = (
  tableHtml: string,
  context: { qid: string | number; questionIndex: number; field: string; tableIndex: number; fullText: string }
): Issue[] => {
  const issues: Issue[] = [];
  const trimmed = tableHtml.trim();

  // 0) Check for swallowed content
  if (REGEX_CONTENT_SWALLOW.test(tableHtml)) {
    issues.push(createIssue(
      context,
      'BAD',
      'CONTENT_SWALLOW',
      'Table swallows layout content (Armadilha/Estratégia) -> AUTO-REMOVE',
      {},
      tableHtml
    ));
    return issues;
  }

  // 1) Markdown instead of HTML
  if (trimmed.startsWith('|') || /\|\s*-{3,}/.test(trimmed)) {
    issues.push(createIssue(context, 'BAD', 'MARKDOWN_DETECTED', 'Output is Markdown format (Expected HTML)', {}, tableHtml));
    return issues;
  }

  // 2) Parse HTML - ADAPTADO para jsdom
  const dom = new JSDOM(tableHtml);
  const doc = dom.window.document;
  const table = doc.querySelector('table');

  if (!table) {
    if (trimmed.length > 0) {
      issues.push(createIssue(context, 'BAD', 'INVALID_HTML', 'No <table> tag found in output', {}, tableHtml));
    }
    return issues;
  }

  const trCount = table.querySelectorAll('tr').length;
  if (trCount === 0) {
    issues.push(createIssue(context, 'WARN', 'NO_DATA', 'Table has no rows (<tr>)', {}, tableHtml));
    return issues;
  }

  const nested = table.querySelectorAll('td table, th table');
  if (nested.length > 0) {
    issues.push(createIssue(context, 'WARN', 'NESTED_TABLE', `Table contains ${nested.length} nested table(s) - verify structure`, {}, tableHtml));
  }

  // 4) Identify header row + body rows
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');

  let headerRow: Element | null = null;
  let bodyRows: Element[] = [];

  if (thead) {
    headerRow = thead.querySelector('tr');

    if (tbody) {
      bodyRows = Array.from(tbody.querySelectorAll('tr'));
    } else {
      const directRows = Array.from(table.querySelectorAll(':scope > tr'));
      bodyRows = directRows.filter(r => !(thead.contains(r)));
    }
  } else {
    const candidateRows = tbody ? Array.from(tbody.querySelectorAll('tr')) : Array.from(table.querySelectorAll(':scope > tr'));
    if (candidateRows.length > 0) {
      headerRow = candidateRows[0];
      bodyRows = candidateRows.slice(1);
    } else {
      const anyRows = Array.from(table.querySelectorAll('tr'));
      headerRow = anyRows[0] ?? null;
      bodyRows = anyRows.slice(1);
    }
  }

  const headerCellsEls = headerRow ? Array.from(headerRow.querySelectorAll('th, td')) : [];
  if (!headerRow || headerCellsEls.length === 0) {
    issues.push(createIssue(context, 'WARN', 'NO_HEADER', 'Table has no identifiable header row', {}, tableHtml));
  }

  // 5) Build grid
  const grid = buildGrid(headerRow, bodyRows);
  const expectedCols = grid.expectedCols;

  // Header Analysis for Financial Context
  const headerTexts = headerCellsEls.map(c => getText(c).toLowerCase());
  const isFinancial = headerTexts.some(t =>
    ['débito', 'crédito', 'saldo', 'valor', 'r$', 'custo', 'receita', 'despesa', 'total', 'entradas', 'saídas', 'estoque', 'lucro', 'patrimônio'].some(k => t.includes(k))
  );

  // 6) 1x1 layout abuse
  const totalRows = (headerRow ? 1 : 0) + bodyRows.length;
  if (totalRows === 1 && expectedCols === 1) {
    const txt = headerCellsEls[0] ? getText(headerCellsEls[0]) : '';
    if (txt.length < 100) {
      issues.push(createIssue(context, 'WARN', 'TABLE_1x1', 'Table is 1x1 - possible misuse for layout', {}, tableHtml));
    }
  }

  if (headerRow && bodyRows.length === 0) {
    issues.push(createIssue(context, 'WARN', 'EMPTY_TABLE', 'Table has header but no data rows', {}, tableHtml));
  }

  // 8) Header checks
  headerCellsEls.forEach((el, idx) => {
    const txt = getText(el);
    const headerInnerHtml = (el as any).innerHTML ?? '';

    if (txt.endsWith('($') || txt === ')' || txt === '$)') {
      issues.push(createIssue(context, 'BAD', 'SPLIT_HEADER', `Suspicious Header Split: "${txt}"`, { row: 0, col: idx }, tableHtml));
    }

    if (!txt && !cellHasContent(el)) {
      issues.push(createIssue(context, 'WARN', 'HEADER_EMPTY', `Empty Header (col ${idx + 1})`, { col: idx }, tableHtml));
    }

    if (txt.includes('$') || /\\[a-zA-Z]/.test(txt)) {
      const latex = checkLatexBalance(txt);
      if (latex.broken) {
        issues.push(createIssue(context, 'BAD', 'HEADER_LATEX_BROKEN', `Header LaTeX broken: ${latex.reason} (col ${idx + 1})`, { row: 0, col: idx }, tableHtml));
      }
    }

    if (REGEX_BROKEN_STYLE_VALUE.test(headerInnerHtml)) {
      issues.push(createIssue(context, 'BAD', 'HEADER_BROKEN_STYLE', `Header has escaped HTML in style (col ${idx + 1})`, { row: 0, col: idx }, tableHtml));
    }
  });

  // Detect empty/placeholder headers
  const emptyOrPlaceholderHeaders = headerTexts.filter(h =>
    h === '' || /^[\s|—–-]+$/.test(h.trim())
  );

  if (emptyOrPlaceholderHeaders.length >= 2) {
    issues.push(createIssue(
      context,
      'BAD',
      'MISSING_HEADER_TEXT',
      `${emptyOrPlaceholderHeaders.length} headers are empty/placeholder - needs header names or colspan`,
      {},
      tableHtml
    ));
  }

  // Duplicate headers
  const nonEmpty = headerTexts.filter(h => h !== '' && !/^[\s|—–-]+$/.test(h.trim()));
  const dups = nonEmpty.filter((h, i) => nonEmpty.indexOf(h) !== i);
  if (dups.length > 0) {
    issues.push(createIssue(context, 'BAD', 'HEADER_DUP', `Duplicate Headers: ${[...new Set(dups)].join(', ')}`, {}, tableHtml));
  }

  // 9) Ghost columns
  if (expectedCols > 1 && bodyRows.length > 0) {
    const colHasContent = grid.colHasContent.slice(0, expectedCols);

    let trailing = 0;
    for (let i = colHasContent.length - 1; i >= 0; i--) {
      if (!colHasContent[i]) trailing++;
      else break;
    }

    if (trailing >= 3) {
      issues.push(createIssue(
        context,
        'BAD',
        'GHOST_COLUMNS',
        `${trailing} trailing ghost columns detected`,
        {},
        tableHtml
      ));
    } else {
      colHasContent.forEach((has, cIdx) => {
        if (!has) {
          const severity: 'BAD' | 'WARN' = (cIdx === expectedCols - 1) ? 'BAD' : 'WARN';
          issues.push(createIssue(context, severity, 'GHOST_COLUMN', `Ghost Column (Col ${cIdx + 1} empty in all rows)`, { col: cIdx }, tableHtml));
        }
      });
    }
  }

  // 10) Row width mismatch
  grid.rowWidths.forEach((w, rIdx) => {
    if (expectedCols > 0 && w !== expectedCols) {
      issues.push(createIssue(
        context,
        'BAD',
        'COL_MISMATCH',
        `Row ${rIdx + 1}: ${w} logical cols (expected ${expectedCols})`,
        { row: rIdx },
        tableHtml
      ));
    }
  });

  // 11) Per-cell checks
  const cellsByRow: Map<number, GridCell[]> = new Map();
  grid.bodyCells.forEach(gc => {
    if (!cellsByRow.has(gc.row)) cellsByRow.set(gc.row, []);
    cellsByRow.get(gc.row)!.push(gc);
  });
  for (const [r, arr] of cellsByRow.entries()) {
    arr.sort((a, b) => a.col - b.col);
    cellsByRow.set(r, arr);
  }

  grid.bodyCells.forEach(gc => {
    const td = gc.el;
    const text = getText(td);
    const innerHTML = (td as any).innerHTML ?? '';

    if (REGEX_SPLIT_CELL.test(text)) {
      issues.push(createIssue(
        context,
        'BAD',
        'SPLIT_CELL',
        `Split Cell ("${text}") at R${gc.row + 1}:C${gc.col + 1}`,
        { row: gc.row, col: gc.col },
        tableHtml
      ));
    }

    const trimmedText = text.trim();
    if (REGEX_SPLIT_OPERATOR.test(text) && trimmedText.length === 1) {
      issues.push(createIssue(
        context,
        'BAD',
        'SPLIT_CELL',
        `Split Operator ("${text}") at R${gc.row + 1}:C${gc.col + 1}`,
        { row: gc.row, col: gc.col },
        tableHtml
      ));
    }

    if (REGEX_AI_LAZY.test(text)) {
      issues.push(createIssue(
        context,
        'BAD',
        'AI_LAZY',
        `AI Placeholder: "${text}"`,
        { row: gc.row, col: gc.col },
        tableHtml
      ));
    }

    if (text.includes('$') || /\\[a-zA-Z]/.test(text)) {
      const latex = checkLatexBalance(text);
      if (latex.broken) {
        issues.push(createIssue(
          context,
          'BAD',
          'LATEX_BROKEN',
          `LaTeX broken (${latex.reason}) at R${gc.row + 1}:C${gc.col + 1}`,
          { row: gc.row, col: gc.col },
          tableHtml
        ));
      }
    }

    if (REGEX_BROKEN_ENTITY.test(innerHTML)) {
      issues.push(createIssue(
        context,
        'WARN',
        'BROKEN_ENTITY',
        `Broken HTML entity at R${gc.row + 1}:C${gc.col + 1}`,
        { row: gc.row, col: gc.col },
        tableHtml
      ));
    }

    if (REGEX_BROKEN_STYLE_VALUE.test(innerHTML)) {
      issues.push(createIssue(
        context,
        'BAD',
        'BROKEN_STYLE_VALUE',
        `Cell has escaped HTML in style at R${gc.row + 1}:C${gc.col + 1}`,
        { row: gc.row, col: gc.col },
        tableHtml
      ));
    }

    if (/\.{3,}$|…$/.test(text) && text.length > 10) {
      issues.push(createIssue(
        context,
        'WARN',
        'TRUNCATED_CONTENT',
        `Content may be truncated at R${gc.row + 1}:C${gc.col + 1}`,
        { row: gc.row, col: gc.col },
        tableHtml
      ));
    }

    if (!isFinancial) {
      if (text === '' && /&nbsp;|\u00A0/.test(innerHTML) && innerHTML.length > 0 && innerHTML.length < 80) {
        issues.push(createIssue(
          context,
          'WARN',
          'WHITESPACE_ONLY',
          `Cell contains only whitespace/nbsp at R${gc.row + 1}:C${gc.col + 1}`,
          { row: gc.row, col: gc.col },
          tableHtml
        ));
      }
    }
  });

  // 12) Hole detection
  if (!isFinancial) {
    for (let r = 0; r < bodyRows.length; r++) {
      const arr = cellsByRow.get(r) || [];
      if (arr.length < 2) continue;

      const covered = new Array(expectedCols).fill(false);
      arr.forEach(c => {
        for (let i = 0; i < c.colspan; i++) {
          const idx = c.col + i;
          if (idx >= 0 && idx < expectedCols) covered[idx] = true;
        }
      });

      for (let c = 1; c < expectedCols - 1; c++) {
        if (!covered[c] && covered[c - 1] && covered[c + 1]) {
          issues.push(createIssue(
            context,
            'WARN',
            'CELL_HOLE',
            `Potential missing cell at R${r + 1}:C${c + 1}`,
            { row: r, col: c },
            tableHtml
          ));
        }
      }
    }
  }

  const rowspanEls = table.querySelectorAll('[rowspan]');
  const maxRows = (headerRow ? 1 : 0) + bodyRows.length;
  rowspanEls.forEach(el => {
    const rs = safeInt(el.getAttribute('rowspan'), 1);
    if (rs > maxRows) {
      issues.push(createIssue(
        context,
        'BAD',
        'INVALID_ROWSPAN',
        `Rowspan (${rs}) exceeds table rows (${maxRows})`,
        {},
        tableHtml
      ));
    }
  });

  const styled = table.querySelectorAll('[style]');
  styled.forEach(el => {
    const style = el.getAttribute('style') || '';
    if (/:\s*;|:\s*$/.test(style)) {
      issues.push(createIssue(context, 'WARN', 'BROKEN_STYLE', 'Broken inline style detected', {}, tableHtml));
    }
  });

  return issues;
};
