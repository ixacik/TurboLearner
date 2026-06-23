import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import './index.css'
import App, { rootLoader, topicLoader } from './App.tsx'

const router = createBrowserRouter([
  { path: '/', element: <App />, loader: rootLoader },
  { path: '/topics/:topicId', element: <App />, loader: topicLoader },
  { path: '/topics/:topicId/exams/:setId', element: <App />, loader: topicLoader },
  { path: '/topics/:topicId/exams/:setId/answers', element: <App />, loader: topicLoader },
  { path: '/TurboLearner', element: <App />, loader: rootLoader },
  { path: '/TurboLearner/topics/:topicId', element: <App />, loader: topicLoader },
  { path: '/TurboLearner/topics/:topicId/exams/:setId', element: <App />, loader: topicLoader },
  { path: '/TurboLearner/topics/:topicId/exams/:setId/answers', element: <App />, loader: topicLoader },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
