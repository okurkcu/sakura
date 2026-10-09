import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';

import { render } from 'preact';

import { App } from './app.js';

const root = document.getElementById('app');
if (root !== null) {
  render(<App />, root);
}
