import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Palette } from './Palette';
import '../styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <Palette />
  </StrictMode>,
);
