// Worker entry: loads the polyfills before the pdf.js worker so it also runs on Chromium builds that
// lack the newest JavaScript APIs (see polyfills.js). The pdf.js worker initialises itself on import.
import './polyfills.js';
import '../vendor/pdfjs/pdf.worker.mjs';
