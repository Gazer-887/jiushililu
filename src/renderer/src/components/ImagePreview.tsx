// 同一签发URL用于缩略图与浮层，不再复制资产；浮层属于本卡，关卡即卸载。
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export default function ImagePreview({ url, name }: { url: string; name: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <>
      {failed ? <div role="alert">图片无法解码，可用系统程序查看</div> : (
        <button className="fp-image-button" aria-label={`放大查看${name}`} onClick={() => setExpanded(true)}>
          <img className="fp-card-image" src={url} alt={name} onError={() => setFailed(true)} />
        </button>
      )}
      {expanded && <ImageLightbox url={url} name={name} close={() => setExpanded(false)} />}
    </>
  )
}

function ImageLightbox({ url, name, close }: { url: string; name: string; close: () => void }): JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    button.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  return createPortal(
    <div className="fp-lightbox" role="dialog" aria-modal="true" aria-label={`${name}图片预览`}
      onClick={event => { if (event.target === event.currentTarget) close() }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); close() }
        if (event.key === 'Tab') { event.preventDefault(); button.current?.focus() }
      }}>
      <figure>
        <button ref={button} className="fp-lightbox-close" aria-label="关闭图片预览" onClick={close}>关闭</button>
        <img src={url} alt={name} />
        <figcaption>{name}</figcaption>
      </figure>
    </div>, document.body
  )
}
