'use client'

import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { operatorWebSocketProtocols } from '@/lib/operator-auth'

function getPtyWsUrl(sessionId: string): string {
  const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL
  if (gatewayUrl) {
    return `${gatewayUrl.replace(/^http/, 'ws')}/ws/pty/${sessionId}`
  }
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}/ws/pty/${sessionId}`
  }
  return `ws://127.0.0.1:7777/ws/pty/${sessionId}`
}

/** Page Visibility as a hook — emits the current document.visibilityState and
 *  updates on change. Inlined (the fork has no shared use-page-visibility). */
function usePageVisibility(): boolean {
  const [visible, setVisible] = useState(
    typeof document !== 'undefined' ? document.visibilityState === 'visible' : true,
  )
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

/**
 * Live xterm.js view onto a session's interactive `claude` PTY, served over
 * /ws/pty/:sessionId. Display-only: input flows through the sibling <ChatInput />,
 * which POSTs to the engine; the interactive engine injects the prompt into this
 * same warm PTY via bracketed-paste, so the user sees it appear in xterm.
 */
export function CliTerminal({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const visible = usePageVisibility()
  const [hasOutput, setHasOutput] = useState(false)
  const hasOutputRef = useRef(false)
  const markHasOutput = (value: boolean) => {
    hasOutputRef.current = value
    setHasOutput(value)
  }

  useEffect(() => {
    if (!sessionId) return
    if (!containerRef.current) return

    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      theme: { background: '#0b0b0c' },
      scrollback: 5000,
      scrollOnUserInput: true,
      // Display-only: input flows through the sibling ChatInput, never via xterm.
      disableStdin: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)

    const ws = new WebSocket(getPtyWsUrl(sessionId), operatorWebSocketProtocols())
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    // Force text presentation for monochrome TUI glyphs that iOS Safari renders
    // as colour emoji — appending U+FE0E (zero-width text selector) is universal.
    const TEXT_PRESENT_GLYPHS = /[⏰-⏿■-◿☀-⛿]/g
    const decoder = new TextDecoder('utf-8')
    const forceTextGlyphs = (s: string) => s.replace(TEXT_PRESENT_GLYPHS, (m) => m + '︎')

    ws.onmessage = (e) => {
      // Text frames carry JSON control messages (e.g. {"type":"reset"} on PTY
      // respawn); data is always binary.
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data)
          if (msg?.type === 'reset') {
            term.reset()
            markHasOutput(false)
            return
          }
        } catch {
          /* not JSON — treat as plain text */
        }
        term.write(forceTextGlyphs(e.data))
        if (!hasOutputRef.current && e.data.length > 0) markHasOutput(true)
      } else {
        const bytes = new Uint8Array(e.data as ArrayBuffer)
        term.write(forceTextGlyphs(decoder.decode(bytes, { stream: true })))
        if (!hasOutputRef.current && bytes.byteLength > 0) markHasOutput(true)
      }
    }

    let raf: number | null = null
    const scheduleFit = () => {
      if (raf !== null) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = null
        const rect = containerRef.current?.getBoundingClientRect()
        // Wait for real layout — fitting at width 0 locks claude's TUI to ~11 cols.
        if (!rect || rect.width < 50 || rect.height < 30) return
        try { fit.fit() } catch { /* container not yet sized */ }
        if (term.cols > 0 && term.rows > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
      })
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'viewing', viewing: document.visibilityState === 'visible' }))
      scheduleFit()
    }

    window.addEventListener('resize', scheduleFit)
    scheduleFit()

    const ro = new ResizeObserver(() => scheduleFit())
    ro.observe(containerRef.current)

    // Touch-to-scroll via xterm's scrollLines() (iOS .scrollTop quirk workaround).
    const wrapper = containerRef.current
    const PX_PER_LINE = 17
    let touchStartY = 0
    let linesSent = 0
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      touchStartY = e.touches[0].clientY
      linesSent = 0
    }
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      const targetLines = Math.trunc((touchStartY - e.touches[0].clientY) / PX_PER_LINE)
      const delta = targetLines - linesSent
      if (delta === 0) return
      term.scrollLines(delta)
      linesSent = targetLines
    }
    wrapper.addEventListener('touchstart', onTouchStart, { passive: true })
    wrapper.addEventListener('touchmove', onTouchMove, { passive: true })

    return () => {
      window.removeEventListener('resize', scheduleFit)
      ro.disconnect()
      wrapper.removeEventListener('touchstart', onTouchStart)
      wrapper.removeEventListener('touchmove', onTouchMove)
      if (raf !== null) cancelAnimationFrame(raf)
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'viewing', viewing: false })) } catch { /* ignore */ }
      }
      ws.close()
      wsRef.current = null
      term.dispose()
    }
  }, [sessionId])

  // Page Visibility: tell the backend to start/stop the keep-alive grace window,
  // and on return-to-visible trigger a resize so a reaped PTY respawns at geometry.
  useEffect(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try { ws.send(JSON.stringify({ type: 'viewing', viewing: visible })) } catch { /* ignore */ }
    if (visible) window.dispatchEvent(new Event('resize'))
  }, [visible])

  return (
    <div
      style={{
        position: 'relative',
        flex: 1,
        minHeight: 0,
        width: '100%',
        overflow: 'hidden',
        background: '#0b0b0c',
        paddingTop: '1rem',
        boxSizing: 'border-box',
      }}
    >
      <div ref={containerRef} tabIndex={-1} style={{ height: '100%', width: '100%', overflow: 'hidden', background: '#0b0b0c' }} />
      {!hasOutput && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            padding: '1rem',
            color: '#888',
            fontFamily: 'monospace',
            fontSize: 12,
            pointerEvents: 'none',
            textAlign: 'center',
          }}
        >
          Waiting for the interactive claude PTY… send a message below to spawn it.
        </div>
      )}
    </div>
  )
}
