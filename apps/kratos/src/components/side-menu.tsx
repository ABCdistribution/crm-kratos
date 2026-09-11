'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home,
  Store,
  Package,
  CalendarDays,
  Footprints,
  ShoppingCart,
  ShieldAlert,
  BadgePercent,
  Settings,
  LogOut,
  Menu,
  X,
  type LucideIcon,
} from 'lucide-react';
import { logout } from '@/lib/auth-actions';
import { Avatar } from './avatar';
import { NotificationsBell } from './notifications-bell';
import { ThemeToggle } from './theme-toggle';
import type { Me, NotificationItem } from '@/lib/api';

type Leaf = { href: string; label: string; icon: LucideIcon; roles?: string[] };
type Section = { label: string | null; children: Leaf[] };

/**
 * Navigation kratos — l'espace web du commercial, scopé « mon périmètre ».
 * Libellés toujours visibles (pas de survol nécessaire).
 * (Gestion utilisateurs, imports ERP, planification des tournées et stats équipe
 *  vivent dans helios, pas ici.)
 */
const SECTIONS: Section[] = [
  { label: null, children: [{ href: '/', label: 'Accueil', icon: Home }] },
  {
    label: 'Mon terrain',
    children: [
      { href: '/clients', label: 'Mes magasins', icon: Store },
      { href: '/tournees', label: 'Mon agenda', icon: CalendarDays },
      { href: '/visites', label: 'Historique de visites', icon: Footprints },
      { href: '/commandes', label: 'Mes commandes', icon: ShoppingCart },
    ],
  },
  {
    label: 'Catalogue',
    children: [
      { href: '/produits', label: 'Produits', icon: Package },
      { href: '/promos', label: 'Promos / PEM', icon: BadgePercent },
      { href: '/qualite', label: 'Qualité & rappels', icon: ShieldAlert },
    ],
  },
  {
    label: 'Moi',
    children: [{ href: '/parametres', label: 'Paramètres', icon: Settings }],
  },
];

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

/** Marque « K Kratos » (réutilisée sidebar + barre mobile). */
function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-sm font-bold text-white dark:bg-accent dark:text-brand">
        K
      </span>
      <span className="text-lg font-bold tracking-tight">Kratos</span>
    </Link>
  );
}

/** Contenu du menu (navigation + pied utilisateur), partagé sidebar / tiroir mobile. */
function MenuPanel({
  me,
  notifications,
}: {
  me: Me;
  notifications: { nonLues: number; items: NotificationItem[] };
}) {
  const pathname = usePathname();

  return (
    <>
      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        {SECTIONS.map((section, i) => {
          const children = section.children.filter((c) => !c.roles || c.roles.includes(me.role));
          if (children.length === 0) return null;
          return (
            <div key={section.label ?? i} className={i > 0 ? 'mt-5' : ''}>
              {section.label ? (
                <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                  {section.label}
                </p>
              ) : null}
              <ul className="flex flex-col gap-0.5">
                {children.map((c) => {
                  const Icon = c.icon;
                  const active = isActive(pathname, c.href);
                  return (
                    <li key={c.href}>
                      <Link
                        href={c.href}
                        className={`group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                          active
                            ? 'bg-brand font-medium text-white shadow-sm dark:bg-accent dark:text-brand'
                            : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-white dark:hover:bg-accent/20'
                        }`}
                      >
                        {/* Surbrillance cyan translucide au survol ; texte blanc et icônes lavande conservés. */}
                        <Icon size={17} className={`shrink-0 ${active ? '' : 'text-[#7D8CCE]'}`} />
                        {c.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      {/* Utilisateur + déconnexion */}
      <div className="border-t border-neutral-200 p-3 dark:border-navy-700">
        <div className="flex items-center gap-2.5 px-1">
          <Avatar src={`/avatar/${me.id}`} initials={initials(me.displayName)} size={36} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{me.displayName}</p>
            <p className="truncate text-xs text-neutral-400">{me.email ?? me.username}</p>
          </div>
          <NotificationsBell nonLues={notifications.nonLues} items={notifications.items} />
          <ThemeToggle />
          <form action={logout}>
            <button
              type="submit"
              className="rounded-lg p-2 text-neutral-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
              aria-label="Déconnexion"
              title="Déconnexion"
            >
              <LogOut size={16} />
            </button>
          </form>
        </div>
      </div>
    </>
  );
}

export function SideMenu({
  me,
  notifications,
}: {
  me: Me;
  notifications: { nonLues: number; items: NotificationItem[] };
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Le tiroir se referme à chaque navigation (clic sur un lien du menu).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Échap ferme le tiroir ; le fond de page ne défile pas tant qu'il est ouvert.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  const surface =
    'border-neutral-200 bg-white text-neutral-800 dark:border-navy-700 dark:bg-navy-950 dark:text-neutral-100';

  return (
    <>
      {/* ≥ md : sidebar permanente (comportement historique). */}
      <aside className={`sticky top-0 z-20 hidden h-screen w-60 shrink-0 flex-col border-r md:flex ${surface}`}>
        <div className="px-4 py-4">
          <Brand />
        </div>
        <MenuPanel me={me} notifications={notifications} />
      </aside>

      {/* < md : barre supérieure avec hamburger. */}
      <header className={`sticky top-0 z-20 flex items-center gap-2 border-b px-3 py-2.5 md:hidden ${surface}`}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg p-2 text-neutral-600 transition hover:bg-neutral-100 dark:text-white dark:hover:bg-accent/20"
          aria-label="Ouvrir le menu"
          aria-expanded={open}
        >
          <Menu size={22} />
        </button>
        <div className="flex-1">
          <Brand />
        </div>
        <NotificationsBell nonLues={notifications.nonLues} items={notifications.items} />
        <ThemeToggle />
      </header>

      {/* < md : tiroir coulissant + voile de fond. */}
      {open ? (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Menu principal">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            aria-label="Fermer le menu"
            onClick={() => setOpen(false)}
          />
          <div className={`absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r shadow-xl ${surface}`}>
            <div className="flex items-center justify-between px-4 py-4">
              <Brand />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg p-2 text-neutral-500 transition hover:bg-neutral-100 dark:text-white dark:hover:bg-accent/20"
                aria-label="Fermer le menu"
              >
                <X size={20} />
              </button>
            </div>
            <MenuPanel me={me} notifications={notifications} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function initials(displayName: string): string {
  return displayName
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}
