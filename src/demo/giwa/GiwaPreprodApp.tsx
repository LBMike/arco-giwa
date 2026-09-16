import { Outlet } from "react-router-dom"
import { GiwaHeader } from "./components"
import { Footer } from "../components/Footer"
import { GIWA_FOOTER_LINKS } from "./footer-links"

export function GiwaPreprodApp({ admin = false }: { admin?: boolean }) {
  return (
    <div className="arco-demo flex min-h-screen flex-col bg-[var(--color-arco-page)] text-foreground">
      <GiwaHeader admin={admin} />
      <main className="mx-auto w-full max-w-[var(--container-page)] flex-1 px-8 py-8">
        <Outlet />
      </main>
      <Footer links={GIWA_FOOTER_LINKS} />
    </div>
  )
}
