'use client';
import { useState, useRef } from 'react';

export default function Home() {
    const [file, setFile] = useState(null);
    const [status, setStatus] = useState('idle');
    const [progress, setProgress] = useState({ current: 0, total: 0, repaired: 0, errors: 0 });
    const [logs, setLogs] = useState([]);
    const [downloadUrl, setDownloadUrl] = useState(null);
    const fileInputRef = useRef(null);
    const abortRef = useRef(false);

  const addLog = (msg, type = 'info') => {
        const time = new Date().toLocaleTimeString();
        setLogs(prev => [...prev.slice(-100), { time, msg, type }]);
  };

  const handleFileSelect = (e) => {
        const f = e.target.files[0];
        if (f && f.name.endsWith('.json')) {
                setFile(f);
                setStatus('idle');
                setProgress({ current: 0, total: 0, repaired: 0, errors: 0 });
                setLogs([]);
                setDownloadUrl(null);
                addLog(`Arquivo selecionado: ${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB)`);
        }
  };

  const startProcessing = async () => {
        if (!file) return;
        setStatus('uploading');
        addLog('Lendo arquivo JSON...');
        abortRef.current = false;

        try {
                const text = await file.text();
                const questions = JSON.parse(text);

          if (!Array.isArray(questions)) {
                    throw new Error('JSON deve ser um array de questões');
          }

          addLog(`${questions.length} questões encontradas`);
                setProgress({ current: 0, total: questions.length, repaired: 0, errors: 0 });
                setStatus('processing');

          const BATCH_SIZE = 10;
                const results = [...questions];
                let totalRepaired = 0;
                let totalErrors = 0;

          for (let i = 0; i < questions.length; i += BATCH_SIZE) {
                    if (abortRef.current) {
                                addLog('Processamento cancelado pelo usuário', 'warn');
                                break;
                    }

                  const batch = questions.slice(i, i + BATCH_SIZE);
                    const batchIndices = batch.map((_, idx) => i + idx);

                  try {
                              const response = await fetch('/api/process', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ questions: batch, indices: batchIndices }),
                              });

                      if (!response.ok) {
                                    throw new Error(`API error: ${response.status}`);
                      }

                      const data = await response.json();

                      data.results.forEach((result, idx) => {
                                    const originalIdx = batchIndices[idx];
                                    if (result.repaired) {
                                                    results[originalIdx] = result.question;
                                                    totalRepaired++;
                                    }
                                    if (result.error) {
                                                    totalErrors++;
                                                    addLog(`Erro Q${originalIdx}: ${result.error}`, 'error');
                                    }
                      });

                      setProgress({
                                    current: Math.min(i + BATCH_SIZE, questions.length),
                                    total: questions.length,
                                    repaired: totalRepaired,
                                    errors: totalErrors
                      });

                      if (data.tablesFound > 0) {
                                    addLog(`Batch ${Math.floor(i/BATCH_SIZE)+1}: ${data.tablesRepaired}/${data.tablesFound} tabelas reparadas`);
                      }

                  } catch (err) {
                              addLog(`Erro no batch ${Math.floor(i/BATCH_SIZE)+1}: ${err.message}`, 'error');
                              totalErrors += batch.length;
                  }

                  await new Promise(r => setTimeout(r, 100));
          }

          const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                setDownloadUrl(url);

          setStatus('done');
                addLog(`Concluído! ${totalRepaired} tabelas reparadas, ${totalErrors} erros`, 'success');

        } catch (err) {
                setStatus('error');
                addLog(`Erro: ${err.message}`, 'error');
        }
  };

  const stopProcessing = () => {
        abortRef.current = true;
        addLog('Parando processamento...', 'warn');
  };

  const downloadFile = () => {
        if (!downloadUrl) return;
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = file.name.replace('.json', '_repaired.json');
        a.click();
  };

  const percent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
        <div style={{ maxWidth: 900, margin: '0 auto', padding: 20 }}>
      <h1 style={{ color: '#2563eb', marginBottom: 10 }}>TableRepair AI</h1>
      <p style={{ color: '#666', marginBottom: 30 }}>
        Repare tabelas quebradas em questões de concurso usando IA
          </p>

      <div 
        onClick={() => fileInputRef.current?.click()}
        style={{
                    border: '2px dashed #ccc',
                    borderRadius: 10,
                    padding: 40,
                    textAlign: 'center',
                    cursor: 'pointer',
                    marginBottom: 20,
                    backgroundColor: file ? '#f0f9ff' : '#fafafa'
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
{file ? (
            <div>
              <div style={{ fontSize: 40, marginBottom: 10 }}>📄</div>
              <div style={{ fontWeight: 'bold' }}>{file.name}</div>
            <div style={{ color: '#666' }}>{(file.size / 1024 / 1024).toFixed(2)} MB</div>
  </div>
        ) : (
                    <div>
                      <div style={{ fontSize: 40, marginBottom: 10 }}>📁</div>
            <div>Clique para selecionar o arquivo JSON</div>
          </div>
        )}
</div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
{status === 'idle' && file && (
            <button
             onClick={startProcessing}
             style={{
                             flex: 1,
                             padding: '15px 30px',
                             fontSize: 16,
                             fontWeight: 'bold',
                             backgroundColor: '#2563eb',
                             color: 'white',
                             border: 'none',
                             borderRadius: 8,
                             cursor: 'pointer'
             }}
          >
            Iniciar Processamento
              </button>
        )}

{status === 'processing' && (
            <button
             onClick={stopProcessing}
             style={{
                             flex: 1,
                             padding: '15px 30px',
                             fontSize: 16,
                             fontWeight: 'bold',
                             backgroundColor: '#dc2626',
                             color: 'white',
                             border: 'none',
                             borderRadius: 8,
                             cursor: 'pointer'
             }}
          >
            Parar
              </button>
        )}

{status === 'done' && downloadUrl && (
            <button
             onClick={downloadFile}
             style={{
                             flex: 1,
                             padding: '15px 30px',
                             fontSize: 16,
                             fontWeight: 'bold',
                             backgroundColor: '#16a34a',
                             color: 'white',
                             border: 'none',
                             borderRadius: 8,
                             cursor: 'pointer'
             }}
          >
            Baixar JSON Reparado
              </button>
        )}
</div>

{progress.total > 0 && (
          <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
            <span>Progresso: {progress.current} / {progress.total}</span>
              <span>{percent}%</span>
  </div>
          <div style={{ backgroundColor: '#e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
            <div
              style={{
                                width: `${percent}%`,
                                height: 20,
                                backgroundColor: status === 'error' ? '#dc2626' : '#2563eb',
                                transition: 'width 0.3s'
              }}
            />
              </div>
          <div style={{ display: 'flex', gap: 20, marginTop: 10, color: '#666' }}>
            <span>Reparadas: {progress.repaired}</span>
            <span>Erros: {progress.errors}</span>
              </div>
              </div>
      )}

{logs.length > 0 && (
          <div
           style={{
                         backgroundColor: '#1e293b',
                         color: '#e2e8f0',
                         padding: 15,
                         borderRadius: 8,
                         fontFamily: 'monospace',
                         fontSize: 13,
                         maxHeight: 300,
                         overflow: 'auto'
           }}
        >
{logs.map((log, i) => (
              <div key={i} style={{ 
                        color: log.type === 'error' ? '#f87171' : 
                                     log.type === 'warn' ? '#fbbf24' : 
                                     log.type === 'success' ? '#4ade80' : '#e2e8f0'
              }}>
              [{log.time}] {log.msg}
</div>
          ))}
            </div>
      )}
</div>
  );
}
