import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { initAuth } from './auth'
// The app's typefaces, self-hosted so it renders the same offline / in Docker.
import '@fontsource/open-sans/latin-400.css'
import '@fontsource/open-sans/latin-600.css'
import '@fontsource/open-sans/latin-700.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-600.css'
import './styles.css'

const root = ReactDOM.createRoot(document.getElementById('root')!)

initAuth()
  .then((auth) => {
    if (!auth.canView) {
      root.render(
        <div className="loading">
          Signed in as {auth.userName ?? 'unknown user'}, but no access — ask an admin for the
          &nbsp;<code>feature-planner-viewer</code> role, a team's <code>feature-planner-editor:&lt;team&gt;</code> role, or <code>feature-planner-admin</code>.{' '}
          <a href="#" onClick={auth.logout}>Log out</a>
        </div>,
      )
      return
    }
    root.render(
      <React.StrictMode>
        <App auth={auth} />
      </React.StrictMode>,
    )
  })
  .catch((e) => {
    root.render(<div className="loading">Login failed: {String(e)}</div>)
  })
