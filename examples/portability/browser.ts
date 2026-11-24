import { runScenario } from './scenario.js';
const button = document.querySelector<HTMLButtonElement>('#run')!;
const output = document.querySelector<HTMLElement>('#result')!;
button.addEventListener('click', async () => {
  button.disabled = true; output.textContent = 'Checking…'; output.dataset.status = 'running';
  try {
    const browser = await runScenario();
    const response = await fetch('/check');
    if (!response.ok) throw new Error(`Worker HTTP ${response.status}`);
    const worker: unknown = await response.json();
    const comparable = (_key: string, value: unknown) => _key === 'nodeGlobals' ? undefined : value;
    if (JSON.stringify(browser, comparable) !== JSON.stringify(worker, comparable)) throw new Error('Browser/Worker result mismatch');
    output.textContent = JSON.stringify({ browser, worker }, null, 2); output.dataset.status = 'passed';
  } catch (error) { output.textContent = String(error); output.dataset.status = 'failed'; }
  finally { button.disabled = false; }
});
