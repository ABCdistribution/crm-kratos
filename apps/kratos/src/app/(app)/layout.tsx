import { redirect } from 'next/navigation';
import { getMe, getNotifications } from '@/lib/api';
import { SideMenu } from '@/components/side-menu';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe();
  if (!me) redirect('/login');
  const notifications = await getNotifications();

  return (
    <div className="flex min-h-screen">
      <SideMenu me={me} notifications={notifications ?? { nonLues: 0, items: [] }} />
      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-[88rem] px-6 py-6">{children}</div>
      </main>
    </div>
  );
}
