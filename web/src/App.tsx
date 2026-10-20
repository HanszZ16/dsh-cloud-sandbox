import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { ApiError, api, type Me } from './api.ts'
import { AdminPage } from './pages/Admin.tsx'
import { AccountPage } from './pages/Account.tsx'
import { LaunchPage } from './pages/Launch.tsx'
import { LoginPage } from './pages/Login.tsx'
import { Spinner } from './ui.tsx'

interface Session {
  me: Me | null
  refresh: () => Promise<Me | null>
}

const SessionContext = createContext<Session>({ me: null, refresh: async () => null })

export const useSession = () => useContext(SessionContext)

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const next = await api.me()
      setMe(next)
      return next
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error
      setMe(null)
      return null
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!loaded) {
    return (
      <div className="center-fill">
        <Spinner />
      </div>
    )
  }
  return (
    <SessionContext.Provider value={{ me, refresh }}>
      <Routes>
        <Route path="/login" element={me ? <Navigate to="/" replace /> : <LoginPage />} />
        <Route path="/" element={<RequireUser>{<LaunchPage />}</RequireUser>} />
        <Route path="/account" element={<RequireUser>{<AccountPage />}</RequireUser>} />
        <Route path="/admin/*" element={<RequireUser admin>{<AdminPage />}</RequireUser>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SessionContext.Provider>
  )
}

function RequireUser({ children, admin }: { children: React.ReactNode; admin?: boolean }) {
  const { me } = useSession()
  const location = useLocation()
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  if (admin && me.role !== 'admin') return <Navigate to="/" replace />
  return <>{children}</>
}
