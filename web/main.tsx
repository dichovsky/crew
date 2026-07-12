/** Browser entry: mount the Console app onto the index.html shell. */
import { render } from 'preact';
import { App } from './app';
import styles from './styles.css';

// Keep the stylesheet inside the authenticated JS bundle. A separate static
// CSS request would also need the per-run token; injecting trusted build-time
// text avoids a second protected asset without weakening the server policy.
const stylesheet = document.createElement('style');
stylesheet.dataset.crewStyles = '';
stylesheet.textContent = styles;
document.head.appendChild(stylesheet);

const root = document.getElementById('app');
if (root !== null) {
  render(<App />, root);
}
