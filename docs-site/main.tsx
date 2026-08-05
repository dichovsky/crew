/** Browser entry: mount the documentation site onto the index.html shell. */
import { render } from 'preact';
import { App } from './app';
import styles from './styles.css';

// esbuild loads the stylesheet as text (--loader:.css=text) and it is injected here,
// so the built page is a single self-contained bundle with no second asset request.
const stylesheet = document.createElement('style');
stylesheet.dataset.crewDocsStyles = '';
stylesheet.textContent = styles;
document.head.appendChild(stylesheet);

const root = document.getElementById('app');
if (root !== null) {
  render(<App />, root);
}
