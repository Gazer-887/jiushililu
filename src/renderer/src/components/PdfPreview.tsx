// 不将PDF内容作为HTML执行：可信宿主组件和本地worker绘制真实页面。
import { useEffect, useRef, useState } from 'react'
import { getDocument, PDFWorker } from 'pdfjs-dist/build/pdf.js'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import LocalPdfWorker from 'pdfjs-dist/build/pdf.worker.min.js?worker'

export default function PdfPreview({ handleId, name }: { handleId: string; name: string }): JSX.Element {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [scale, setScale] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [rendering, setRendering] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let alive = true
    let worker: PDFWorker | undefined
    let nativeWorker: Worker | undefined
    let loading: ReturnType<typeof getDocument> | undefined
    setDocument(null); setError(null); setPageNumber(1); setScale(1)
    void (async () => {
      try {
        const bytes = await window.api.previewRead(handleId)
        if (!alive) return
        // 提供本地端口，避免pdfjs因file: origin检测走blob/CDN包装器。
        nativeWorker = new LocalPdfWorker()
        // 已装3.11.174运行时接受Worker端口，但其声明把port误收窄为null；只在该适配点纠正。
        worker = new PDFWorker({ port: nativeWorker } as unknown as NonNullable<ConstructorParameters<typeof PDFWorker>[0]>)
        loading = getDocument({ data: new Uint8Array(bytes), worker, useSystemFonts: true, isEvalSupported: false })
        const pdf = await loading.promise
        if (alive) setDocument(pdf)
      } catch {
        if (alive) setError('PDF解析失败：文件可能损坏、加密或不支持，请用系统程序查看')
      }
    })()
    return () => {
      alive = false
      const release = (): void => { worker?.destroy(); nativeWorker?.terminate() }
      if (loading) void loading.destroy().catch(() => {
        // 清理异常只留固定分类，不输出PDF正文/上游错误体；finally仍强制释放两个worker。
        console.warn('[PDF预览]读取任务关闭失败，已强制释放worker')
      }).finally(release)
      else release()
    }
  }, [handleId])

  useEffect(() => {
    if (!document || !canvasRef.current) return
    let alive = true
    let task: RenderTask | undefined
    setRendering(true); setError(null)
    void (async () => {
      try {
        const page = await document.getPage(pageNumber)
        if (!alive || !canvasRef.current) return
        const viewport = page.getViewport({ scale })
        if (viewport.width * viewport.height > 16 * 1024 * 1024 || viewport.width > 8192 || viewport.height > 8192) throw new Error('页面画布过大')
        const canvas = canvasRef.current
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
        const context = canvas.getContext('2d')
        if (!context) throw new Error('浏览器画布不可用')
        task = page.render({ canvasContext: context, viewport })
        await task.promise
      } catch {
        if (alive) setError('PDF页面绘制失败或页面尺寸超出安全上限')
      } finally { if (alive) setRendering(false) }
    })()
    return () => { alive = false; task?.cancel() }
  }, [document, pageNumber, scale])

  const next = (): void => setPageNumber(n => Math.min(document?.numPages ?? 1, n + 1))
  const previous = (): void => setPageNumber(n => Math.max(1, n - 1))
  return (
    <section className="fp-pdf-viewer" tabIndex={0} aria-label={`${name} PDF预览`} onKeyDown={event => {
      if (event.key === 'ArrowRight') { event.preventDefault(); next() }
      if (event.key === 'ArrowLeft') { event.preventDefault(); previous() }
    }}>
      <div className="fp-pdf-toolbar">
        <button aria-label="PDF上一页" disabled={!document || pageNumber === 1} onClick={previous}>上一页</button>
        <span className="fp-pdf-page-number">{pageNumber} / {document?.numPages ?? '—'}</span>
        <button aria-label="PDF下一页" disabled={!document || pageNumber === document.numPages} onClick={next}>下一页</button>
        <button aria-label="PDF缩小" disabled={scale <= 0.5} onClick={() => setScale(n => Math.max(0.5, n - 0.25))}>−</button>
        <span className="fp-pdf-zoom">{Math.round(scale * 100)}%</span>
        <button aria-label="PDF放大" disabled={scale >= 3} onClick={() => setScale(n => Math.min(3, n + 0.25))}>＋</button>
      </div>
      {error && <div className="fp-pdf-error" role="alert">{error}</div>}
      {!document && !error && <div role="status">正在读取PDF…</div>}
      <div className="fp-pdf-stage" aria-busy={rendering}>
        {document && <canvas ref={canvasRef} className="fp-pdf-canvas" aria-label={`${name} 第${pageNumber}页`} />}
      </div>
    </section>
  )
}
