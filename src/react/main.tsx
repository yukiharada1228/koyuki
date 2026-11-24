/** @jsxRuntime automatic */
import { createRoot } from 'react-dom/client';
import { connectTags } from './remote.js';
import { TagScreenView } from './view.js';
const root = createRoot(document.getElementById('root')!);
connectTags().then(connection => root.render(<TagScreenView connection={connection} />))
  .catch(error => root.render(<main role="alert"><h1>読み込めませんでした</h1><p>{String(error)}</p><button onClick={() => location.reload()}>再読み込み</button></main>));
