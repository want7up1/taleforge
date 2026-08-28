import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { PixelDialogProvider } from './PixelDialog.tsx'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <PixelDialogProvider>
    <App />
  </PixelDialogProvider>,
)
