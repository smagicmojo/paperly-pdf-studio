import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs'
import './styles.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString()

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const TOOLS = [
  ['select', '↖', 'Select'],
  ['edit', 'T✎', 'Edit text'],
  ['text', 'T', 'Add text'],
  ['whiteout', '▱', 'Whiteout'],
  ['highlight', '▰', 'Highlight'],
  ['draw', '✎', 'Draw'],
  ['shape', '□', 'Shape'],
  ['signature', 'S', 'Sign'],
  ['image', '▧', 'Image'],
]

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

function hexToRgb(hex) {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((x) => x + x).join('') : value
  return rgb(parseInt(full.slice(0, 2), 16) / 255, parseInt(full.slice(2, 4), 16) / 255, parseInt(full.slice(4, 6), 16) / 255)
}

function dataUrlBytes(value) {
  return Uint8Array.from(atob(value.split(',')[1]), (char) => char.charCodeAt(0))
}

async function renderPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const pdfDocument = await pdfjsLib.getDocument({ data: bytes }).promise
  const pages = []
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1.5 })
    const text = await page.getTextContent()
    const textItems = text.items.filter((item) => item.str?.trim()).map((item, itemIndex) => {
      const transform = pdfjsLib.Util.transform(viewport.transform, item.transform)
      const fontSize = Math.max(8, Math.hypot(transform[2], transform[3]))
      const left = transform[4]
      const top = transform[5] - fontSize
      return {
        id: `pdf-text-${pageNumber}-${itemIndex}`,
        text: item.str,
        x: clamp((left / viewport.width) * 100, 0, 100),
        y: clamp((top / viewport.height) * 100, 0, 100),
        w: clamp(((item.width || fontSize * Math.max(item.str.length, 1) * 0.5) * viewport.scale / viewport.width) * 100, 0.5, 100),
        h: clamp((fontSize / viewport.height) * 100, 0.8, 15),
        fontSize,
      }
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    pages.push({
      index: pageNumber - 1,
      width: viewport.width,
      height: viewport.height,
      displayWidth: Math.min(860, viewport.width),
      dataUrl: canvas.toDataURL('image/jpeg', 0.9),
      textItems,
      rotation: 0,
    })
  }
  return { bytes, pages }
}

function downloadPdf(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 800)
}

function App() {
  const [file, setFile] = useState(null)
  const [sourceBytes, setSourceBytes] = useState(null)
  const [pages, setPages] = useState([])
  const [objects, setObjects] = useState({})
  const [activePage, setActivePage] = useState(0)
  const [tool, setTool] = useState('select')
  const [zoom, setZoom] = useState(100)
  const [selectedId, setSelectedId] = useState(null)
  const [editingText, setEditingText] = useState(null)
  const [interaction, setInteraction] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [imageKey, setImageKey] = useState(0)
  const fileInput = useRef(null)
  const imageInput = useRef(null)

  const activeObjects = objects[activePage] || []
  const selectedObject = useMemo(() => activeObjects.find((item) => item.id === selectedId) || null, [activeObjects, selectedId])
  const activePdfPage = pages[activePage]

  useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(''), 3500)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        event.preventDefault()
        removeObject(selectedId)
      }
      if (event.key === 'Escape') {
        setSelectedId(null)
        setEditingText(null)
        setTool('select')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  function updatePageObjects(pageIndex, updater) {
    setObjects((current) => ({ ...current, [pageIndex]: typeof updater === 'function' ? updater(current[pageIndex] || []) : updater }))
  }

  function addObject(type, values = {}) {
    const item = {
      id: uid(), type, x: values.x ?? 18, y: values.y ?? 18, w: values.w ?? 24, h: values.h ?? 7,
      text: values.text ?? (type === 'signature' ? 'Your signature' : type === 'text' ? 'Type here' : ''),
      color: values.color ?? '#15243e', size: values.size ?? (type === 'signature' ? 25 : 17),
      opacity: values.opacity ?? (type === 'highlight' ? 0.34 : 1), points: values.points || [], dataUrl: values.dataUrl || '', sourceTextId: values.sourceTextId || '',
    }
    updatePageObjects(activePage, (current) => [...current, item])
    setSelectedId(item.id)
    setEditingText(null)
    setTool('select')
    return item
  }

  function pointFromEvent(event) {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100),
      y: clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100),
    }
  }

  function startBox(event) {
    if (!['whiteout', 'highlight', 'shape', 'draw'].includes(tool)) return
    if (event.target.closest('.object-shell') || event.target.closest('.text-hit')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const point = pointFromEvent(event)
    setSelectedId(null)
    setEditingText(null)
    setInteraction({ kind: tool, start: point, current: point, points: [point] })
  }

  function moveBox(event) {
    if (!interaction) return
    const point = pointFromEvent(event)
    if (interaction.kind === 'draw') {
      setInteraction((current) => ({ ...current, current: point, points: [...current.points, point] }))
    } else {
      setInteraction((current) => ({ ...current, current: point }))
    }
  }

  function finishBox() {
    if (!interaction) return
    if (interaction.kind === 'draw' && interaction.points.length > 1) {
      addObject('draw', { x: 0, y: 0, w: 100, h: 100, points: interaction.points })
    }
    if (['whiteout', 'highlight', 'shape'].includes(interaction.kind)) {
      const x = Math.min(interaction.start.x, interaction.current.x)
      const y = Math.min(interaction.start.y, interaction.current.y)
      const w = Math.max(Math.abs(interaction.current.x - interaction.start.x), 1.2)
      const h = Math.max(Math.abs(interaction.current.y - interaction.start.y), 1.2)
      if (w > 1.3 && h > 1.3) addObject(interaction.kind, { x, y, w, h })
    }
    setInteraction(null)
  }

  function startMove(event, id) {
    if (tool !== 'select') return
    event.stopPropagation()
    event.preventDefault()
    const item = activeObjects.find((entry) => entry.id === id)
    if (!item) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setSelectedId(id)
    setEditingText(null)
    setInteraction({ kind: 'move', id, start: pointFromEvent(event), origin: { x: item.x, y: item.y, w: item.w, h: item.h } })
  }

  function startResize(event, id, corner) {
    event.stopPropagation()
    event.preventDefault()
    const item = activeObjects.find((entry) => entry.id === id)
    if (!item) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setSelectedId(id)
    setInteraction({ kind: 'resize', id, corner, start: pointFromEvent(event), origin: { x: item.x, y: item.y, w: item.w, h: item.h } })
  }

  function moveObject(event) {
    if (!interaction || !['move', 'resize'].includes(interaction.kind)) return
    const item = activeObjects.find((entry) => entry.id === interaction.id)
    if (!item) return
    const point = pointFromEvent(event)
    const dx = point.x - interaction.start.x
    const dy = point.y - interaction.start.y
    const origin = interaction.origin
    const next = interaction.kind === 'move'
      ? { x: clamp(origin.x + dx, 0, 100 - origin.w), y: clamp(origin.y + dy, 0, 100 - origin.h), w: origin.w, h: origin.h }
      : resizeRect(origin, interaction.corner, dx, dy)
    updatePageObjects(activePage, (current) => current.map((entry) => entry.id === interaction.id ? { ...entry, ...next } : entry))
  }

  function resizeRect(origin, corner, dx, dy) {
    let x = origin.x
    let y = origin.y
    let w = origin.w
    let h = origin.h
    if (corner.includes('e')) w = clamp(origin.w + dx, 2, 100 - origin.x)
    if (corner.includes('s')) h = clamp(origin.h + dy, 2, 100 - origin.y)
    if (corner.includes('w')) { x = clamp(origin.x + dx, 0, origin.x + origin.w - 2); w = origin.w - (x - origin.x) }
    if (corner.includes('n')) { y = clamp(origin.y + dy, 0, origin.y + origin.h - 2); h = origin.h - (y - origin.y) }
    return { x, y, w, h }
  }

  function stopInteraction() {
    setInteraction(null)
  }

  function pageClick(event) {
    if (event.target.closest('.object-shell') || event.target.closest('.text-hit')) return
    if (tool === 'text') addObject('text', { ...pointFromEvent(event), w: 26, h: 6 })
    if (tool === 'signature') addObject('signature', { ...pointFromEvent(event), w: 30, h: 10 })
  }

  function selectPdfText(item) {
    setSelectedId(null)
    setEditingText({ ...item })
    setTool('edit')
  }

  function whiteoutPdfText(item) {
    addObject('whiteout', { x: Math.max(0, item.x - 0.5), y: Math.max(0, item.y - 0.8), w: Math.min(100 - item.x, item.w + 1), h: Math.min(100 - item.y, item.h + 1.6), sourceTextId: item.id })
  }

  function applyTextEdit() {
    if (!editingText) return
    const cover = { x: Math.max(0, editingText.x - 0.5), y: Math.max(0, editingText.y - 0.8), w: Math.min(100 - editingText.x, editingText.w + 1), h: Math.min(100 - editingText.y, editingText.h + 1.6), sourceTextId: editingText.id }
    const replacement = { x: editingText.x, y: editingText.y, w: editingText.w, h: editingText.h, text: editingText.text, size: clamp(editingText.fontSize || 14, 9, 42), sourceTextId: editingText.id }
    updatePageObjects(activePage, (current) => [...current.filter((item) => item.sourceTextId !== editingText.id), makeObject('whiteout', cover), makeObject('text', replacement)])
    setEditingText(null)
    setTool('select')
    setNotice('Text replacement added. Download to save it.')
  }

  function makeObject(type, values) {
    return { id: uid(), type, x: values.x, y: values.y, w: values.w, h: values.h, text: values.text || '', color: values.color || '#15243e', size: values.size || 17, opacity: values.opacity ?? (type === 'highlight' ? 0.34 : 1), points: values.points || [], dataUrl: values.dataUrl || '', sourceTextId: values.sourceTextId || '' }
  }

  function removeObject(id) {
    updatePageObjects(activePage, (current) => current.filter((item) => item.id !== id))
    setSelectedId(null)
  }

  function changeObject(property, value) {
    if (!selectedObject) return
    updatePageObjects(activePage, (current) => current.map((item) => item.id === selectedObject.id ? { ...item, [property]: value } : item))
  }

  async function openPdf(incoming) {
    const selected = Array.from(incoming || []).find((entry) => entry.type === 'application/pdf' || entry.name.toLowerCase().endsWith('.pdf'))
    if (!selected) return
    setBusy(true)
    setNotice('Opening PDF locally…')
    try {
      const loaded = await renderPdf(selected)
      setFile(selected)
      setSourceBytes(loaded.bytes)
      setPages(loaded.pages)
      setObjects({})
      setActivePage(0)
      setZoom(100)
      setTool('select')
      setSelectedId(null)
      setEditingText(null)
    } catch (error) {
      console.error(error)
      setNotice('This PDF could not be opened.')
    } finally {
      setBusy(false)
    }
  }

  async function addImage(event) {
    const image = event.target.files?.[0]
    if (!image) return
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.readAsDataURL(image)
    })
    addObject('image', { dataUrl, w: 28, h: 18 })
    setImageKey((current) => current + 1)
  }

  function changeTool(next) {
    setTool(next)
    setSelectedId(null)
    setEditingText(null)
  }

  async function exportPdf() {
    if (!sourceBytes || !pages.length) return
    setBusy(true)
    setNotice('Preparing your edited PDF locally…')
    try {
      const source = await PDFDocument.load(sourceBytes)
      const output = await PDFDocument.create()
      const font = await output.embedFont(StandardFonts.Helvetica)
      const italic = await output.embedFont(StandardFonts.TimesRomanItalic)
      for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
        const pageInfo = pages[pageIndex]
        const [page] = await output.copyPages(source, [pageInfo.index])
        output.addPage(page)
        page.setRotation(degrees(pageInfo.rotation || 0))
        const { width, height } = page.getSize()
        for (const item of objects[pageIndex] || []) {
          const x = (item.x / 100) * width
          const y = height - ((item.y + item.h) / 100) * height
          const w = (item.w / 100) * width
          const h = (item.h / 100) * height
          if (item.type === 'whiteout') page.drawRectangle({ x, y, width: w, height: h, color: rgb(1, 1, 1), opacity: 1 })
          if (item.type === 'highlight') page.drawRectangle({ x, y, width: w, height: h, color: rgb(1, 0.82, 0.15), opacity: item.opacity })
          if (item.type === 'shape') page.drawRectangle({ x, y, width: w, height: h, borderColor: hexToRgb(item.color), borderWidth: 1.5, opacity: item.opacity })
          if (item.type === 'text') page.drawText(item.text || '', { x, y: y + h * 0.15, size: Number(item.size) || 17, font, color: hexToRgb(item.color) })
          if (item.type === 'signature') page.drawText(item.text || 'Signature', { x, y: y + h * 0.15, size: Number(item.size) || 25, font: italic, color: rgb(0.08, 0.2, 0.3) })
          if (item.type === 'draw' && item.points.length > 1) {
            for (let index = 1; index < item.points.length; index += 1) {
              const first = item.points[index - 1]
              const second = item.points[index]
              page.drawLine({ start: { x: (first.x / 100) * width, y: height - (first.y / 100) * height }, end: { x: (second.x / 100) * width, y: height - (second.y / 100) * height }, thickness: 2, color: hexToRgb(item.color) })
            }
          }
          if (item.type === 'image' && item.dataUrl) {
            const image = item.dataUrl.includes('image/png') ? await output.embedPng(dataUrlBytes(item.dataUrl)) : await output.embedJpg(dataUrlBytes(item.dataUrl))
            page.drawImage(image, { x, y, width: w, height: h })
          }
        }
      }
      const bytes = await output.save({ useObjectStreams: true, addDefaultPage: false })
      downloadPdf(bytes, 'paperly-edited.pdf')
      setNotice(`Downloaded ${formatBytes(bytes)} PDF`)
    } catch (error) {
      console.error(error)
      setNotice('Export failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  function rotatePage(index) {
    setPages((current) => current.map((page, pageIndex) => pageIndex === index ? { ...page, rotation: ((page.rotation || 0) + 90) % 360 } : page))
  }

  function deletePage(index) {
    if (pages.length <= 1) return
    setPages((current) => current.filter((_, pageIndex) => pageIndex !== index))
    setObjects((current) => { const next = {}; Object.entries(current).forEach(([key, value]) => { const pageIndex = Number(key); if (pageIndex !== index) next[pageIndex > index ? pageIndex - 1 : pageIndex] = value }); return next })
    setActivePage((current) => clamp(current >= index ? current - 1 : current, 0, pages.length - 2))
  }

  if (!pages.length) return <StartScreen onOpen={() => fileInput.current?.click()} onDrop={openPdf} busy={busy} inputRef={fileInput} onChange={openPdf} />

  const baseWidth = Math.min(activePdfPage.displayWidth || 860, 860)
  const pageWidth = Math.round(baseWidth * zoom / 100)
  const pageHeight = Math.round(pageWidth * activePdfPage.height / activePdfPage.width)
  const rectangle = interaction && ['whiteout', 'highlight', 'shape'].includes(interaction.kind) ? rectFromPoints(interaction.start, interaction.current) : null

  return <div className="app">
    <input ref={fileInput} className="hidden-input" type="file" accept="application/pdf,.pdf" onChange={(event) => { openPdf(event.target.files); event.target.value = '' }} />
    <input key={imageKey} ref={imageInput} className="hidden-input" type="file" accept="image/png,image/jpeg" onChange={addImage} />
    <header className="editor-header">
      <button className="brand" onClick={() => { setPages([]); setFile(null) }}><span className="brand-mark">P</span><span>paperly</span></button>
      <div className="file-title"><span className="pdf-label">PDF</span><strong>{file?.name}</strong><span>{pages.length} pages · {formatBytes(file?.size)}</span></div>
      <div className="header-actions"><button className="header-btn" onClick={() => fileInput.current?.click()}>Open PDF</button><button className="download-btn" onClick={exportPdf} disabled={busy}>{busy ? 'Working…' : 'Download PDF'}</button></div>
    </header>
    <div className="editor-shell">
      <aside className="page-sidebar"><div className="side-heading">PAGES <span>{pages.length}</span></div><div className="page-list">{pages.map((page, index) => <div className={'page-card ' + (activePage === index ? 'active' : '')} key={`${page.index}-${index}`}><button className="page-thumb" onClick={() => { setActivePage(index); setSelectedId(null); setEditingText(null) }}><img src={page.dataUrl} alt={`Page ${index + 1}`} /><span>{index + 1}</span></button><div className="page-actions"><button onClick={() => rotatePage(index)} title="Rotate page">↻</button><button onClick={() => deletePage(index)} title="Delete page">×</button></div></div>)}</div><button className="add-page-btn" onClick={() => fileInput.current?.click()}>＋ Add PDF pages</button></aside>
      <main className="editor-main">
        <div className="toolbar"><div className="tool-group">{TOOLS.map(([id, icon, label]) => <button key={id} className={'tool-btn ' + (tool === id ? 'active' : '')} onClick={() => id === 'image' ? imageInput.current?.click() : changeTool(id)}><span>{icon}</span><small>{label}</small></button>)}</div><div className="zoom-group"><button onClick={() => setZoom((value) => clamp(value - 25, 50, 300))}>−</button><strong>{zoom}%</strong><input aria-label="Zoom" type="range" min="50" max="300" step="25" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /><button onClick={() => setZoom((value) => clamp(value + 25, 50, 300))}>＋</button><button className="fit-btn" onClick={() => setZoom(100)}>Fit</button></div></div>
        <div className="canvas-scroll"><div className="page-canvas" style={{ width: pageWidth, height: pageHeight }} onClick={pageClick} onPointerDown={startBox} onPointerMove={(event) => { moveBox(event); moveObject(event) }} onPointerUp={finishBox} onPointerCancel={stopInteraction}><img src={activePdfPage.dataUrl} alt="PDF page" /><div className={'text-hit-layer ' + (tool === 'edit' || tool === 'whiteout' ? 'active' : '')}>{activePdfPage.textItems.map((item) => <button key={item.id} className="text-hit" style={{ left: item.x + '%', top: item.y + '%', width: item.w + '%', height: item.h + '%' }} onClick={(event) => { event.stopPropagation(); tool === 'whiteout' ? whiteoutPdfText(item) : selectPdfText(item) }} title={tool === 'whiteout' ? 'Whiteout this text' : 'Edit this text'}>{item.text}</button>)}</div><div className="object-layer">{activeObjects.map((item) => <CanvasObject key={item.id} item={item} selected={selectedId === item.id} onPointerDown={startMove} onResize={startResize} onSelect={(event) => { event.stopPropagation(); setSelectedId(item.id); setEditingText(null) }} />)}{rectangle && <div className={'draw-rectangle ' + interaction.kind} style={{ left: rectangle.x + '%', top: rectangle.y + '%', width: rectangle.w + '%', height: rectangle.h + '%' }} />}{interaction?.kind === 'draw' && <svg className="draw-preview" viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points={interaction.points.map((point) => `${point.x},${point.y}`).join(' ')} /></svg>}</div></div></div>
        <div className="canvas-status"><span>Page {activePage + 1} of {pages.length}</span><span>{tool === 'select' ? 'Drag objects to move · Use corner handles to resize · Delete removes selection' : tool === 'edit' ? 'Click a text region to edit it' : tool === 'whiteout' ? 'Click text or drag a box to cover content' : 'Click or drag on the page to place this tool'}</span></div>
      </main>
      <aside className="inspector"><div className="side-heading">{editingText ? 'EDIT TEXT' : selectedObject ? 'SELECTED OBJECT' : 'DOCUMENT'}</div>{editingText ? <div className="inspector-body"><div className="inspector-title">Existing PDF text</div><textarea className="edit-area" value={editingText.text} onChange={(event) => setEditingText((current) => ({ ...current, text: event.target.value }))} /><button className="apply-btn" onClick={applyTextEdit}>Replace text</button><button className="ghost-btn" onClick={() => setEditingText(null)}>Cancel</button><p className="helper">The original text is covered and your replacement is placed in the same location.</p></div> : selectedObject ? <ObjectInspector item={selectedObject} onChange={changeObject} onDelete={() => removeObject(selectedObject.id)} /> : <div className="document-inspector"><div className="empty-icon">✦</div><strong>No selection</strong><p>Select an object or choose Edit text, then click the PDF.</p><div className="doc-info"><span>File</span><strong>{file?.name}</strong><span>Privacy</span><strong className="green">Local only</strong></div></div>}</aside>
    </div>
    {notice && <div className="notice"><span>{busy ? '◌' : '✓'}</span>{notice}</div>}
  </div>
}

function rectFromPoints(first, second) {
  return { x: Math.min(first.x, second.x), y: Math.min(first.y, second.y), w: Math.abs(second.x - first.x), h: Math.abs(second.y - first.y) }
}

function CanvasObject({ item, selected, onPointerDown, onResize, onSelect }) {
  const style = { left: item.x + '%', top: item.y + '%', width: item.w + '%', height: item.h + '%', color: item.color, fontSize: item.size + 'px', opacity: item.opacity }
  return <div className={'object-shell ' + item.type + '-object ' + (selected ? 'selected' : '')} style={style} onPointerDown={(event) => onPointerDown(event, item.id)} onClick={onSelect}>
    {item.type === 'text' && item.text}
    {item.type === 'signature' && <span>{item.text}</span>}
    {item.type === 'image' && <img src={item.dataUrl} alt="Inserted" />}
    {item.type === 'draw' && <svg viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points={item.points.map((point) => `${point.x},${point.y}`).join(' ')} /></svg>}
    {item.type === 'shape' && null}
    {selected && <><button className="delete-handle" onPointerDown={(event) => { event.stopPropagation(); onSelect(event); }}>×</button>{['nw', 'ne', 'sw', 'se'].map((corner) => <button key={corner} className={'resize-handle ' + corner} onPointerDown={(event) => onResize(event, item.id, corner)} aria-label={'Resize ' + corner} />)}</>}
  </div>
}

function ObjectInspector({ item, onChange, onDelete }) {
  return <div className="inspector-body"><div className="object-kind"><span className="kind-dot" />{item.type}</div>{['text', 'signature'].includes(item.type) && <label>Content<textarea className="edit-area" value={item.text} onChange={(event) => onChange('text', event.target.value)} /></label>}{!['whiteout', 'highlight', 'image', 'draw'].includes(item.type) && <label>Color<input type="color" value={item.color} onChange={(event) => onChange('color', event.target.value)} /></label>}{['text', 'signature'].includes(item.type) && <label>Size<input type="range" min="9" max="54" value={item.size} onChange={(event) => onChange('size', Number(event.target.value))} /></label>}{item.type === 'highlight' && <label>Opacity<input type="range" min="0.1" max="0.8" step="0.05" value={item.opacity} onChange={(event) => onChange('opacity', Number(event.target.value))} /></label>}<button className="delete-action" onClick={onDelete}>Delete object</button></div>
}

function StartScreen({ onOpen, onDrop, busy, inputRef, onChange }) {
  return <div className="start-screen"><header className="start-header"><button className="brand"><span className="brand-mark">P</span><span>paperly</span></button><span className="privacy"><i /> Your documents stay on your device</span></header><main className="start-content"><div className="start-kicker">PDF EDITOR</div><h1>Make every page<br /><em>work harder.</em></h1><p>Edit text, cover sensitive details, sign, annotate and download a finished PDF—all in one focused workspace.</p><div className="upload-card" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); onDrop(event.dataTransfer.files) }} onClick={onOpen}><div className="upload-icon">↑</div><strong>{busy ? 'Opening your PDF…' : 'Drop a PDF here'}</strong><span>or click to browse from your device</span><small>Private, local processing · No account required</small></div><input ref={inputRef} className="hidden-input" type="file" accept="application/pdf,.pdf" onChange={(event) => { onChange(event.target.files); event.target.value = '' }} /><div className="feature-row"><span>✦ Text editing</span><span>▱ Whiteout</span><span>✎ Sign & annotate</span><span>⌁ 300% zoom</span></div></main></div>
}

createRoot(document.getElementById('root')).render(<App />)
