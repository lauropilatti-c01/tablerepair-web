// API Route para processar tabelas com IA
// Usa OpenRouter API para reparar tabelas quebradas

const OPENROUTER_MODEL = "google/gemini-2.0-flash-001";
const FIELDS_TO_CHECK = ['enunciado', 'resolucao', 'resolucao_aprofundada', 'texto_associado'];

export async function POST(request) {
    try {
          const { questions, indices } = await request.json();

      if (!questions || !Array.isArray(questions)) {
              return Response.json({ error: 'questions array required' }, { status: 400 });
      }

      const apiKey = process.env.OPENROUTER_KEY;
          if (!apiKey) {
                  return Response.json({ error: 'OPENROUTER_KEY not configured' }, { status: 500 });
          }

      const results = [];
          let tablesFound = 0;
          let tablesRepaired = 0;

      for (let i = 0; i < questions.length; i++) {
              const question = { ...questions[i] };
              let questionRepaired = false;

            for (const field of FIELDS_TO_CHECK) {
                      const content = question[field];
                      if (!content || typeof content !== 'string') continue;

                const tableMatches = content.match(/<table[\s\S]*?<\/table>/gi);
                      if (!tableMatches) continue;

                for (let t = 0; t < tableMatches.length; t++) {
                            const tableHtml = tableMatches[t];
                            tablesFound++;

                        const issues = detectTableIssues(tableHtml);
                            if (issues.length === 0) continue;

                        try {
                                      const repairedHtml = await repairTable(tableHtml, question, apiKey);
                                      if (repairedHtml && repairedHtml !== tableHtml) {
                                                      question[field] = question[field].replace(tableHtml, repairedHtml);
                                                      tablesRepaired++;
                                                      questionRepaired = true;
                                      }
                        } catch (err) {
                                      console.error('Repair error:', err.message);
                        }
                }
            }

            results.push({
                      index: indices[i],
                      question: question,
                      repaired: questionRepaired,
                      error: null
            });
      }

      return Response.json({ results, tablesFound, tablesRepaired });

    } catch (err) {
          console.error('Process error:', err);
          return Response.json({ error: err.message }, { status: 500 });
    }
}

function detectTableIssues(html) {
    const issues = [];

  const cells = html.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
    const emptyCells = cells.filter(c => {
          const text = c.replace(/<[^>]+>/g, '').trim();
          return text === '' || text === '-' || text === '—';
    });

  if (emptyCells.length > cells.length * 0.5) {
        issues.push('too_many_empty_cells');
  }

  const headers = html.match(/<th[^>]*>[\s\S]*?<\/th>/gi) || [];
    const genericHeaders = headers.filter(h => {
          const text = h.replace(/<[^>]+>/g, '').trim().toLowerCase();
          return /^col(una)?\s*\d+$/i.test(text) || text === '' || text === '-';
    });

  if (genericHeaders.length > 0) {
        issues.push('generic_headers');
  }

  if (html.includes('$') && !html.includes('$$')) {
        const dollarCount = (html.match(/\$/g) || []).length;
        if (dollarCount % 2 !== 0) {
                issues.push('broken_latex');
        }
  }

  if (html.includes('colspan') || html.includes('rowspan')) {
        issues.push('merged_cells');
  }

  return issues;
}

async function repairTable(tableHtml, question, apiKey) {
    const context = {
          materia: question.materia || '',
          assunto: question.assunto || '',
          enunciado: (question.enunciado || '').substring(0, 500)
    };

  const prompt = buildRepairPrompt(tableHtml, context);

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
                "Authorization": "Bearer " + apiKey,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://tablerepair.vercel.app",
                "X-Title": "TableRepair AI"
        },
        body: JSON.stringify({
                model: OPENROUTER_MODEL,
                messages: [{ role: "user", content: prompt }],
                max_tokens: 16000
        })
  });

  if (!response.ok) {
        throw new Error("OpenRouter API Error: " + response.status);
  }

  const data = await response.json();
    let result = data.choices?.[0]?.message?.content || '';

  result = result.replace(/```html/g, '').replace(/```/g, '').trim();

  const tableMatch = result.match(/<table[\s\S]*<\/table>/i);
    return tableMatch ? tableMatch[0] : null;
}

function buildRepairPrompt(tableHtml, context) {
    return `ROLE: You are an Educational Content Expert fixing HTML tables for Brazilian exam questions.

    TASK: Fix the broken HTML table below.

    CONTEXT:
    Subject: ${context.materia || 'General'}
    Topic: ${context.assunto || 'Not specified'}
    Question preview: ${context.enunciado || 'Not available'}

    INSTRUCTIONS:
    1. FIX structural issues (ghost columns, misaligned cells)
    2. REPAIR LaTeX delimiters (ensure $ pairs match)
    3. REMOVE empty/placeholder columns ("Coluna 1", "Coluna 2", etc.)
    4. PRESERVE all original data - do NOT invent content
    5. Keep all text in Portuguese

    BROKEN TABLE:
    ${tableHtml}

    OUTPUT: Return ONLY the fixed <table> HTML. No markdown, no explanations.`;
}
