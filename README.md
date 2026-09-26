# Paperly PDF Studio

A privacy-first, browser-only PDF workspace inspired by familiar online PDF tool workflows. It includes an original interface for:

- PDF Editor: add text, highlight, draw, shapes, images, and signatures
- Fill & Sign: add a drawn signature or initials
- Merge PDF files
- Compress PDF
- Rotate, delete, and reorder pages

## Run locally

```bash
npm install
npm run dev
```

Open the URL shown by Vite. No PDF file is uploaded by this app: files are read and processed in the browser and exported locally.

## Build for GitHub/Vercel/Netlify

```bash
npm run build
```

The `dist` folder can be deployed as a static site. The project intentionally uses original branding and UI rather than copying any third-party branding or assets.

## Current MVP notes

- PDF editing is client-side using `pdf-lib` and `pdfjs-dist`.
- Text overlays, highlights, shapes, freehand drawing, image placement, and signatures are flattened into the exported PDF.
- Existing PDF text is not yet directly rewritten in place; the editor adds new content on top.
- Compression uses PDF image downsampling/re-encoding where possible and otherwise exports the document through the browser.
