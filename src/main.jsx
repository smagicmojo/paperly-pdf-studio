import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib'
import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs'
import './styles.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString()

const TOOL_GROUPS = [
  { title: 'Edit & sign', items: [
    { id: 'editor', icon: '✦', label: 'PDF editor', description: 'Edit, annotate and sign PDFs' },
    { id: 'fill', icon: '✓', label: 'Fill & sign', description: 'Add text, initials and a signature' },
  ]},
  { title: 'Organize', items: [
    { id: 'merge', icon: '⊞', label: 'Merge PDF', description: 'Combine documents into one file' },
    { id: 'compress', icon: '◌', label: 'Compress PDF', description: 'Reduce file size in your browser' },
  ]},
]

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`
}

async function readFileBytes(file) {
  return new Uint8Array(await file.arrayBuffer())
}

async function renderPdf(file, scale = 1.16) {
  const data = await readFileBytes(file)
  const doc = await pdfjsLib.getDocument({ data }).promise
  const pages = []
  for (let index = 1; index <= doc.numPages; index += 1) {
    const page = await doc.getPage(index)
    const viewport = page.getViewport({ scale })
    const textContent = await page.getTextContent()
    const textItems = textContent.items.filter((item) => item.str?.trim()).map((item, textIndex) => {
      const fontSize = Math.max(7, Math.hypot(item.transform[0], item.transform[1]))
      return {
        id: `text-${index}-${textIndex}`,
        text: item.str,
        x: clamp((item.transform[4] / viewport.width) * 100, 0, 100),
        y: clamp(((item.transform[5] - fontSize) / viewport.height) * 100, 0, 100),
        w: clamp(((item.width || fontSize * Math.max(item.str.length, 1) * 0.5) / viewport.width) * 100, 0.5, 100),
        h: clamp((fontSize / viewport.height) * 100, 0.6, 15),
      }
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    pages.push({
      index: index - 1,
      width: viewport.width,
      height: viewport.height,
      dataUrl: canvas.toDataURL('image/jpeg', 0.86),
      textItems,
    })
  }
  return { bytes: data, pages }
}

function downloadBytes(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 500)
}

function App() {
  const [mode, setMode] = useState('home')
  const [activeTool, setActiveTool] = useState('select')
  const [files, setFiles] = useState([])
  const [pages, setPages] = useState([])
  const [activePage, setActivePage] = useState(0)
  const [zoom, setZoom] = useState(100)
  const [selectedText, setSelectedText] = useState(null)
  const [overlays, setOverlays] = useState({})
  const [selectedId, setSelectedId] = useState(null)
  const [isBusy, setIsBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [dragState, setDragState] = useState(null)
  const [imageInputKey, setImageInputKey] = useState(0)
  const [compressionLevel, setCompressionLevel] = useState('balanced')
  const fileInput = useRef(null)
  const imageInput = useRef(null)
  const pageCanvas = useRef(null)

  const selectedOverlay = useMemo(
    () => Object.values(overlays).flat().find((item) => item.id === selectedId),
    [overlays, selectedId],
  )

  useEffect(() => {
    if (!notice) return undefined
    const timeout = setTimeout(() => setNotice(''), 3200)
    return () => clearTimeout(timeout)
  }, [notice])

  const updateOverlays = (pageIndex, next) => {
    setOverlays((current) => ({ ...current, [pageIndex]: next }))
  }

  const openFiles = async (incoming) => {
    const selected = Array.from(incoming || []).filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))
    if (!selected.length) return
    setIsBusy(true)
    setNotice(`Loading ${selected.length} PDF${selected.length > 1 ? 's' : ''} privately in your browser…`)
    try {
      const loaded = await Promise.all(selected.map(async (file) => ({ file, ...(await renderPdf(file)) })))
      setFiles((current) => [...current, ...loaded])
      if (!pages.length) {
        setPages(loaded[0].pages)
        setActivePage(0)
        setZoom(100)
        setSelectedText(null)
        if (mode === 'home') setMode('editor')
      }
    } catch (error) {
      setNotice('That PDF could not be opened. Try another file.')
      console.error(error)
    } finally {
      setIsBusy(false)
    }
  }

  const startTool = (tool) => {
    setActiveTool('select')
    setSelectedId(null)
    setSelectedText(null)
    if (tool === 'fill') setActiveTool('text')
    setMode(tool === 'fill' ? 'editor' : tool)
    if ((tool === 'editor' || tool === 'fill') && !pages.length) fileInput.current?.click()
  }

  const addOverlay = (type, values = {}) => {
    const item = {
      id: uid(), type, x: values.x ?? 18, y: values.y ?? 18, w: values.w ?? (type === 'draw' ? 36 : 22), h: values.h ?? (type === 'draw' ? 18 : 7),
      text: values.text ?? (type === 'signature' ? 'Your signature' : type === 'text' ? 'Type here' : ''),
      color: values.color ?? '#15243e', size: values.size ?? (type === 'signature' ? 25 : 17),
      sourceTextId: values.sourceTextId ?? '',
      points: values.points ?? [], dataUrl: values.dataUrl ?? '',
    }
    const next = [...(overlays[activePage] || []), item]
    updateOverlays(activePage, next)
    setSelectedId(item.id)
    setActiveTool('select')
  }

  const pagePoint = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100),
      y: clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100),
    }
  }

  const handlePageClick = (event) => {
    if (activeTool === 'text') {
      const point = pagePoint(event)
      addOverlay('text', { x: point.x, y: point.y })
    } else if (activeTool === 'highlight') {
      const point = pagePoint(event)
      addOverlay('highlight', { x: point.x, y: point.y, w: 25, h: 5 })
    } else if (activeTool === 'shape') {
      const point = pagePoint(event)
      addOverlay('shape', { x: point.x, y: point.y, w: 23, h: 12 })
    } else if (activeTool === 'signature') {
      const point = pagePoint(event)
      addOverlay('signature', { x: point.x, y: point.y, w: 30, h: 10 })
    }
  }

  const beginDraw = (event) => {
    if (!['draw', 'whiteout'].includes(activeTool)) return
    const point = pagePoint(event)
    setDragState({ points: [point], mode: activeTool })
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const continueDraw = (event) => {
    if (!dragState || !['draw', 'whiteout'].includes(activeTool)) return
    const point = pagePoint(event)
    setDragState((current) => ({ ...current, points: [...current.points, point] }))
  }

  const endDraw = () => {
    if (!dragState) return
    if (dragState.points.length > 1 && dragState.mode === 'draw') {
      addOverlay('draw', { points: dragState.points, x: 0, y: 0, w: 100, h: 100 })
    }
    if (dragState.points.length > 1 && dragState.mode === 'whiteout') {
      const xs = dragState.points.map((point) => point.x)
      const ys = dragState.points.map((point) => point.y)
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      addOverlay('whiteout', { x, y, w: Math.max(Math.abs(Math.max(...xs) - x), 1.5), h: Math.max(Math.abs(Math.max(...ys) - y), 1.5) })
    }
    setDragState(null)
  }

  const selectOverlay = (event, id) => {
    event.stopPropagation()
    setSelectedId(id)
    setActiveTool('select')
  }

  const changeSelected = (property, value) => {
    if (!selectedOverlay) return
    const next = (overlays[activePage] || []).map((item) => item.id === selectedOverlay.id ? { ...item, [property]: value } : item)
    updateOverlays(activePage, next)
  }

  const deleteSelected = () => {
    if (!selectedId) return
    updateOverlays(activePage, (overlays[activePage] || []).filter((item) => item.id !== selectedId))
    setSelectedId(null)
  }

  const selectExistingText = (item) => {
    setSelectedId(null)
    setSelectedText({ ...item, pageIndex: activePage })
    setActiveTool('edit')
  }

  const updateTextDraft = (text) => setSelectedText((current) => current ? { ...current, text } : current)

  const applyTextEdit = () => {
    if (!selectedText) return
    const replacement = {
      id: uid(), type: 'text', sourceTextId: selectedText.id, x: selectedText.x, y: selectedText.y, w: selectedText.w, h: selectedText.h,
      text: selectedText.text, color: '#15243e', size: Math.max(10, Math.round(selectedText.h * pages[activePage].height / 100 * 0.78)),
    }
    const whiteout = {
      id: uid(), type: 'whiteout', sourceTextId: selectedText.id, x: Math.max(0, selectedText.x - 0.4), y: Math.max(0, selectedText.y - 0.6),
      w: Math.min(100 - selectedText.x, selectedText.w + 0.8), h: Math.min(100 - selectedText.y, selectedText.h + 1.2), text: '', color: '#ffffff', size: 0, points: [], dataUrl: '',
    }
    const next = (overlays[activePage] || []).filter((item) => item.sourceTextId !== selectedText.id)
    updateOverlays(activePage, [...next, whiteout, replacement])
    setSelectedId(replacement.id)
    setSelectedText(null)
    setActiveTool('select')
  }

  const whiteoutExistingText = (item) => {
    addOverlay('whiteout', { x: Math.max(0, item.x - 0.4), y: Math.max(0, item.y - 0.6), w: Math.min(100 - item.x, item.w + 0.8), h: Math.min(100 - item.y, item.h + 1.2), sourceTextId: item.id })
  }

  const removePage = (pageIndex) => {
    if (pages.length <= 1) return
    setPages((current) => current.filter((_, index) => index !== pageIndex).map((page, index) => ({ ...page, index })))
    setOverlays((current) => {
      const result = {}
      Object.entries(current).forEach(([key, value]) => {
        const index = Number(key)
        if (index === pageIndex) return
        result[index > pageIndex ? index - 1 : index] = value
      })
      return result
    })
    setActivePage((current) => clamp(current - (current >= pageIndex ? 1 : 0), 0, pages.length - 2))
  }

  const rotatePage = (pageIndex) => {
    setPages((current) => current.map((page, index) => index === pageIndex ? { ...page, rotation: ((page.rotation || 0) + 90) % 360 } : page))
  }

  const addImage = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.readAsDataURL(file)
    })
    addOverlay('image', { dataUrl, w: 28, h: 18 })
    setImageInputKey((key) => key + 1)
  }

  const exportPdf = async (kind = 'edited') => {
    if (!files[0]) return
    setIsBusy(true)
    setNotice(kind === 'compress' ? 'Optimizing your PDF locally…' : 'Preparing your download locally…')
    try {
      const source = await PDFDocument.load(files[0].bytes)
      const output = await PDFDocument.create()
      const font = await output.embedFont(StandardFonts.Helvetica)
      const italic = await output.embedFont(StandardFonts.TimesRomanItalic)
      const sourcePages = source.getPages()
      const selectedPages = pages.map((page) => page.index)
      for (let order = 0; order < selectedPages.length; order += 1) {
        const sourceIndex = selectedPages[order]
        const [copied] = await output.copyPages(source, [sourceIndex])
        const page = output.addPage(copied)
        const { width, height } = page.getSize()
        page.setRotation(degrees(pages[order].rotation || 0))
        const items = overlays[order] || []
        for (const item of items) {
          const x = (item.x / 100) * width
          const y = height - (item.y / 100) * height
          if (item.type === 'text') page.drawText(item.text || '', { x, y, size: Number(item.size) || 17, font, color: hexToRgb(item.color) })
          if (item.type === 'signature') page.drawText(item.text || 'Signature', { x, y, size: Number(item.size) || 25, font: italic, color: hexToRgb('#17334b') })
          if (item.type === 'whiteout') page.drawRectangle({ x, y: y - (item.h / 100) * height, width: (item.w / 100) * width, height: (item.h / 100) * height, color: rgb(1, 1, 1), opacity: 1 })
          if (item.type === 'highlight') page.drawRectangle({ x, y: y - (item.h / 100) * height, width: (item.w / 100) * width, height: (item.h / 100) * height, color: rgb(0.98, 0.82, 0.2), opacity: 0.34 })
          if (item.type === 'shape') page.drawRectangle({ x, y: y - (item.h / 100) * height, width: (item.w / 100) * width, height: (item.h / 100) * height, borderColor: hexToRgb(item.color), borderWidth: 1.5, opacity: 0.85 })
          if (item.type === 'draw' && item.points.length > 1) {
            for (let p = 1; p < item.points.length; p += 1) {
              const a = item.points[p - 1]
              const b = item.points[p]
              page.drawLine({ start: { x: (a.x / 100) * width, y: height - (a.y / 100) * height }, end: { x: (b.x / 100) * width, y: height - (b.y / 100) * height }, thickness: 2, color: hexToRgb(item.color) })
            }
          }
          if (item.type === 'image' && item.dataUrl) {
            const imageBytes = dataUrlToBytes(item.dataUrl)
            const image = item.dataUrl.includes('image/png') ? await output.embedPng(imageBytes) : await output.embedJpg(imageBytes)
            page.drawImage(image, { x, y: y - (item.h / 100) * height, width: (item.w / 100) * width, height: (item.h / 100) * height })
          }
        }
      }
      const saveOptions = kind === 'compress' ? { useObjectStreams: true, addDefaultPage: false, objectsPerTick: 40 } : { useObjectStreams: true, addDefaultPage: false }
      const bytes = await output.save(saveOptions)
      downloadBytes(bytes, kind === 'compress' ? 'paperly-compressed.pdf' : 'paperly-edited.pdf')
      setNotice(`Downloaded ${formatBytes(bytes)} PDF`)
    } catch (error) {
      console.error(error)
      setNotice('Export failed. Please try opening the PDF again.')
    } finally {
      setIsBusy(false)
    }
  }

  const mergeFiles = async () => {
    if (files.length < 2) {
      setNotice('Add at least two PDF files to merge.')
      fileInput.current?.click()
      return
    }
    setIsBusy(true)
    setNotice('Merging files locally…')
    try {
      const output = await PDFDocument.create()
      for (const item of files) {
        const source = await PDFDocument.load(item.bytes)
        const copied = await output.copyPages(source, source.getPageIndices())
        copied.forEach((page) => output.addPage(page))
      }
      const bytes = await output.save({ useObjectStreams: true })
      downloadBytes(bytes, 'paperly-merged.pdf')
      setNotice(`Merged ${files.length} files into ${formatBytes(bytes)} PDF`)
    } catch (error) {
      console.error(error)
      setNotice('Merge failed. Please check that the PDFs are valid.')
    } finally {
      setIsBusy(false)
    }
  }

  const hexToRgb = (hex) => {
    const value = hex.replace('#', '')
    const parsed = value.length === 3 ? value.split('').map((char) => char + char).join('') : value
    return rgb(parseInt(parsed.slice(0, 2), 16) / 255, parseInt(parsed.slice(2, 4), 16) / 255, parseInt(parsed.slice(4, 6), 16) / 255)
  }

  const dataUrlToBytes = (dataUrl) => Uint8Array.from(atob(dataUrl.split(',')[1]), (char) => char.charCodeAt(0))

  const pageStyle = (page) => ({
    transform: `rotate(${page.rotation || 0}deg)`,
    transformOrigin: 'center center',
  })

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setMode('home')}><span className="brand-mark">P</span><span>paperly</span></button>
        <div className="topbar-center"><span className="privacy-pill"><span className="dot" /> Files stay on your device</span></div>
        <div className="topbar-actions"><button className="top-link">Pricing</button><button className="top-link">Help</button><button className="avatar">S</button></div>
      </header>

      <input ref={fileInput} className="hidden-input" type="file" accept="application/pdf,.pdf" multiple onChange={(event) => { openFiles(event.target.files); event.target.value = '' }} />
      <input key={imageInputKey} ref={imageInput} className="hidden-input" type="file" accept="image/png,image/jpeg" onChange={addImage} />

      {mode === 'home' && <Home onOpenFiles={() => fileInput.current?.click()} onTool={startTool} files={files} />}

      {mode === 'editor' && <EditorView
        files={files} pages={pages} activePage={activePage} setActivePage={setActivePage} activeTool={activeTool} setActiveTool={setActiveTool}
        overlays={overlays} selectedId={selectedId} selectedOverlay={selectedOverlay} selectedText={selectedText} setSelectedText={updateTextDraft} onEditText={selectExistingText} onWhiteoutText={whiteoutExistingText} applyTextEdit={applyTextEdit} zoom={zoom} setZoom={setZoom} onPageClick={handlePageClick} beginDraw={beginDraw} continueDraw={continueDraw} endDraw={endDraw}
        selectOverlay={selectOverlay} dragState={dragState} pageStyle={pageStyle} updateOverlays={updateOverlays} setSelectedId={setSelectedId} deleteSelected={deleteSelected}
        changeSelected={changeSelected} removePage={removePage} rotatePage={rotatePage} onAddFiles={() => fileInput.current?.click()} onAddImage={() => imageInput.current?.click()}
        onDownload={() => exportPdf('edited')} onBack={() => setMode('home')} onNotice={setNotice} isBusy={isBusy}
      />}

      {mode === 'merge' && <MergeView files={files} onAddFiles={() => fileInput.current?.click()} onMerge={mergeFiles} onBack={() => setMode('home')} isBusy={isBusy} />}
      {mode === 'compress' && <CompressView files={files} onAddFiles={() => fileInput.current?.click()} onCompress={() => exportPdf('compress')} level={compressionLevel} setLevel={setCompressionLevel} onBack={() => setMode('home')} isBusy={isBusy} />}

      {notice && <div className="toast"><span className="toast-icon">{isBusy ? '◌' : '✓'}</span>{notice}</div>}
    </div>
  )
}

function Home({ onOpenFiles, onTool, files }) {
  return <main className="home-page">
    <section className="hero">
      <div className="eyebrow"><span className="spark">✦</span> A calmer way to work with PDFs</div>
      <h1>PDF work,<br /><em>without the friction.</em></h1>
      <p className="hero-copy">Edit, sign, merge and compress your documents in one focused workspace. Fast, simple, and private by design.</p>
      <button className="primary-btn hero-btn" onClick={onOpenFiles}><span>Upload a PDF</span><span className="arrow">↗</span></button>
      <div className="hero-note"><span className="lock">⌁</span> No account needed · Your files never leave this browser</div>
    </section>
    <section className="tools-section">
      <div className="section-heading"><div><p className="overline">YOUR PDF TOOLKIT</p><h2>Everything you need.<br /><span>Nothing you don't.</span></h2></div><p className="section-intro">A small set of tools for the moments that matter—designed to stay out of your way.</p></div>
      <div className="tool-grid">{TOOL_GROUPS.flatMap((group) => group.items).map((item) => <button className="tool-card" key={item.id} onClick={() => onTool(item.id)}><span className="tool-icon">{item.icon}</span><span className="tool-card-copy"><strong>{item.label}</strong><small>{item.description}</small></span><span className="card-arrow">↗</span></button>)}</div>
    </section>
    <section className="feature-strip"><div className="feature-item"><span className="feature-number">01</span><div><strong>Local by default</strong><p>Work confidently. Your files stay right here in your browser.</p></div></div><div className="feature-item"><span className="feature-number">02</span><div><strong>Designed for flow</strong><p>No clutter, no maze. Just the next useful action.</p></div></div><div className="feature-item"><span className="feature-number">03</span><div><strong>Ready when you are</strong><p>Download clean, finished files whenever you need them.</p></div></div></section>
    {files.length > 0 && <div className="resume-card"><span><strong>{files[0].file.name}</strong><small>{files.length} file{files.length > 1 ? 's' : ''} ready in this browser</small></span><button className="secondary-btn" onClick={() => onTool('editor')}>Continue editing ↗</button></div>}
  </main>
}

function EditorView({ files, pages, activePage, setActivePage, activeTool, setActiveTool, overlays, selectedId, selectedOverlay, selectedText, setSelectedText, onEditText, onWhiteoutText, applyTextEdit, zoom, setZoom, onPageClick, beginDraw, continueDraw, endDraw, selectOverlay, dragState, pageStyle, setSelectedId, deleteSelected, changeSelected, removePage, rotatePage, onAddFiles, onAddImage, onDownload, onBack, isBusy }) {
  const tools = [{ id: 'select', icon: '↖', label: 'Select' }, { id: 'edit', icon: 'T✎', label: 'Edit text' }, { id: 'text', icon: 'T', label: 'Text' }, { id: 'highlight', icon: '▰', label: 'Highlight' }, { id: 'whiteout', icon: '▱', label: 'Whiteout' }, { id: 'draw', icon: '⌁', label: 'Draw' }, { id: 'shape', icon: '□', label: 'Shape' }, { id: 'signature', icon: 'S', label: 'Sign' }, { id: 'image', icon: '▧', label: 'Image' }]
  const page = pages[activePage]
  const paperWidth = zoom === 100 ? 'min(100%, 800px)' : Math.round(800 * zoom / 100) + 'px'
  const handleExistingText = (item) => activeTool === 'whiteout' ? onWhiteoutText(item) : onEditText(item)
  return <div className="workspace"><div className="workspace-top"><button className="back-btn" onClick={onBack}>← <span>All tools</span></button><div className="document-name"><span className="pdf-badge">PDF</span><span>{files[0]?.file.name || 'Untitled document'}</span><small>{pages.length} pages</small></div><div className="workspace-actions"><button className="secondary-btn" onClick={onAddFiles}>＋ Add file</button><button className="primary-btn small-btn" onClick={onDownload} disabled={isBusy}>{isBusy ? 'Preparing…' : 'Download PDF ↗'}</button></div></div>
    <div className="editor-layout"><aside className="thumbnail-panel"><div className="panel-label">PAGES <span>{pages.length}</span></div><div className="thumbnails">{pages.map((item, index) => <div className={`thumbnail-wrap ${activePage === index ? 'active' : ''}`} key={`${item.index}-${index}`}><button className="thumbnail" onClick={() => { setActivePage(index); setSelectedId(null) }}><img src={item.dataUrl} alt={`Page ${index + 1}`} style={pageStyle(item)} /><span>{index + 1}</span></button><div className="thumbnail-actions"><button onClick={() => rotatePage(index)} title="Rotate">↻</button><button onClick={() => removePage(index)} title="Delete page">×</button></div></div>)}</div><button className="add-page" onClick={onAddFiles}>＋ Add pages</button></aside>
      <main className="canvas-area"><div className="canvas-toolbar"><div className="tool-tabs">{tools.map((tool) => <button key={tool.id} className={activeTool === tool.id ? 'active' : ''} onClick={() => tool.id === 'image' ? onAddImage() : setActiveTool(tool.id)}><span>{tool.icon}</span><small>{tool.label}</small></button>)}</div><div className="zoom-control"><button onClick={() => setZoom((value) => clamp(value - 25, 50, 300))} aria-label="Zoom out">−</button><strong>{zoom}%</strong><input type="range" min="50" max="300" step="25" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} aria-label="Zoom level" /><button onClick={() => setZoom((value) => clamp(value + 25, 50, 300))} aria-label="Zoom in">＋</button></div></div><div className="paper-stage"><div className="paper-wrap" style={{ ...pageStyle(page), width: paperWidth, maxHeight: 'none' }} onClick={onPageClick} onPointerDown={beginDraw} onPointerMove={continueDraw} onPointerUp={endDraw} onPointerCancel={endDraw}><img className="paper-image" src={page?.dataUrl} alt="Active PDF page" draggable="false" /><div className={['text-layer', ['edit', 'whiteout'].includes(activeTool) ? 'interactive' : ''].join(' ')}>{(page?.textItems || []).map((item) => <button key={item.id} className="existing-text" style={{ left: item.x + '%', top: item.y + '%', width: item.w + '%', height: item.h + '%' }} onClick={(event) => { event.stopPropagation(); handleExistingText(item) }} title={activeTool === 'whiteout' ? 'Whiteout this text' : 'Edit this text'}>{item.text}</button>)}</div><div className="overlay-layer">{(overlays[activePage] || []).map((item) => <Overlay key={item.id} item={item} selected={selectedId === item.id} onSelect={selectOverlay} />)}{dragState && <svg className="draw-preview" viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points={dragState.points.map((point) => `${point.x},${point.y}`).join(' ')} /></svg>}</div></div></div><div className="stage-footer"><span>Page {activePage + 1} of {pages.length}</span><span className="footer-hint">{activeTool === 'select' ? 'Click an element to select it' : activeTool === 'draw' ? 'Drag on the page to draw' : 'Click on the page to place'}</span></div></main>
      <aside className="properties-panel"><div className="panel-label">PROPERTIES</div>{selectedText ? <div className="property-content text-edit-card"><div className="selection-chip"><span className="selection-dot" />Edit existing text<button onClick={() => setSelectedText(null)}>×</button></div><label className="field-label">Replacement text<textarea value={selectedText.text} onChange={(event) => setSelectedText(event.target.value)} rows="4" /></label><button className="primary-btn small-btn" onClick={applyTextEdit}>Apply replacement</button><p className="property-note">Paperly covers the original text and places your replacement in the same position.</p></div> : selectedOverlay ? <div className="property-content"><div className="selection-chip"><span className="selection-dot" />{selectedOverlay.type === 'signature' ? 'Signature' : selectedOverlay.type[0].toUpperCase() + selectedOverlay.type.slice(1)}<button onClick={deleteSelected}>×</button></div>{['text', 'signature'].includes(selectedOverlay.type) && <label className="field-label">Content<textarea value={selectedOverlay.text} onChange={(event) => changeSelected('text', event.target.value)} rows="3" /></label>}{!['highlight', 'draw', 'image'].includes(selectedOverlay.type) && <label className="field-label">Color<input type="color" value={selectedOverlay.color} onChange={(event) => changeSelected('color', event.target.value)} /></label>}{['text', 'signature'].includes(selectedOverlay.type) && <label className="field-label">Size<input type="range" min="10" max="48" value={selectedOverlay.size} onChange={(event) => changeSelected('size', event.target.value)} /></label>}<button className="delete-btn" onClick={deleteSelected}>Delete element</button></div> : <div className="empty-properties"><span className="properties-icon">✦</span><strong>Select text or an element</strong><p>Choose Edit text to replace existing PDF text, or Whiteout to cover any area.</p></div>}<div className="document-meta"><p className="panel-label">DOCUMENT</p><div><span>File</span><strong>{files[0]?.file.name || '—'}</strong></div><div><span>Original size</span><strong>{formatBytes(files[0]?.file.size)}</strong></div><div><span>Privacy</span><strong className="green-text">Local only</strong></div></div></aside></div></div>
}

function Overlay({ item, selected, onSelect }) {
  const style = { left: `${item.x}%`, top: `${item.y}%`, width: `${item.w}%`, minHeight: `${item.h}%`, color: item.color, fontSize: `${item.size}px` }
  if (item.type === 'image') return <button className={`overlay-item image-overlay ${selected ? 'selected' : ''}`} style={style} onClick={(event) => onSelect(event, item.id)}><img src={item.dataUrl} alt="Inserted" /></button>
  if (item.type === 'whiteout') return <button className={'overlay-item whiteout-overlay ' + (selected ? 'selected' : '')} style={style} onClick={(event) => onSelect(event, item.id)} aria-label="Whiteout area" />
  if (item.type === 'draw') return <button className={`overlay-item draw-overlay ${selected ? 'selected' : ''}`} style={style} onClick={(event) => onSelect(event, item.id)}><svg viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points={item.points.map((point) => `${point.x},${point.y}`).join(' ')} /></svg></button>
  return <button className={`overlay-item ${item.type}-overlay ${selected ? 'selected' : ''}`} style={style} onClick={(event) => onSelect(event, item.id)}>{item.type === 'shape' ? '' : item.type === 'highlight' ? '' : item.text}</button>
}

function MergeView({ files, onAddFiles, onMerge, onBack, isBusy }) {
  return <ToolPage title="Merge PDF files" description="Bring documents together into one clean PDF." icon="⊞" onBack={onBack}><div className="file-tool-card"><div className="drop-zone" onClick={onAddFiles}><span className="drop-icon">＋</span><strong>Drop PDFs here or browse</strong><small>Files are processed locally in your browser</small></div>{files.length > 0 && <div className="file-list">{files.map((item, index) => <div className="file-row" key={`${item.file.name}-${index}`}><span className="file-type">PDF</span><div><strong>{item.file.name}</strong><small>{item.pages.length} pages · {formatBytes(item.file.size)}</small></div><span className="drag-handle">⋮⋮</span></div>)}</div>}<div className="file-tool-footer"><span>{files.length ? `${files.length} document${files.length > 1 ? 's' : ''} selected` : 'No documents selected'}</span><button className="primary-btn" onClick={onMerge} disabled={isBusy}>{isBusy ? 'Merging…' : 'Merge & download ↗'}</button></div></div></ToolPage>
}

function CompressView({ files, onAddFiles, onCompress, level, setLevel, onBack, isBusy }) {
  return <ToolPage title="Compress PDF" description="Make your file lighter without leaving this browser." icon="◌" onBack={onBack}><div className="file-tool-card"><div className="drop-zone compact" onClick={onAddFiles}><span className="drop-icon">＋</span><strong>{files[0]?.file.name || 'Choose a PDF to compress'}</strong><small>{files[0] ? formatBytes(files[0].file.size) : 'Drop a file here or browse'}</small></div><div className="compression-options"><p className="panel-label">COMPRESSION LEVEL</p>{[['balanced', 'Balanced', 'Good quality with a smaller file'], ['strong', 'Strong', 'Smallest practical export'], ['light', 'Light', 'Keep more visual quality']].map(([value, label, helper]) => <button className={`compression-option ${level === value ? 'active' : ''}`} key={value} onClick={() => setLevel(value)}><span className="radio">{level === value ? '●' : '○'}</span><span><strong>{label}</strong><small>{helper}</small></span></button>)}</div><div className="file-tool-footer"><span>{files[0] ? 'Ready to process locally' : 'Choose a file to begin'}</span><button className="primary-btn" onClick={onCompress} disabled={!files[0] || isBusy}>{isBusy ? 'Compressing…' : 'Compress & download ↗'}</button></div></div></ToolPage>
}

function ToolPage({ title, description, icon, onBack, children }) {
  return <div className="tool-page"><div className="tool-page-top"><button className="back-btn" onClick={onBack}>← <span>All tools</span></button><span className="privacy-pill"><span className="dot" /> Local processing</span></div><div className="tool-page-intro"><span className="large-tool-icon">{icon}</span><p className="overline">PAPERLY TOOL</p><h1>{title}</h1><p>{description}</p></div>{children}</div>
}

createRoot(document.getElementById('root')).render(<App />)
