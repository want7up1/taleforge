import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { PixelDialogProvider } from './components/PixelDialog.tsx'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <PixelDialogProvider>
    <App />
  </PixelDialogProvider>,
)

// 可安装应用：注册失败不影响网页本身。开发服务器不走 /assets/，service worker 在那里什么也不缓存
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}
