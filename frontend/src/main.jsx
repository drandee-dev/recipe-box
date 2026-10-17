import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { TimersProvider } from './lib/useTimers.jsx'
import { initPwaUpdates } from './lib/pwa.js'
import './lib/theme.js'
import './index.css'

initPwaUpdates()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <TimersProvider>
      <App />
    </TimersProvider>
  </StrictMode>,
)
