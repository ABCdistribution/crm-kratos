import { listClientsEnriched, type ClientsEnrichedResult } from '@/lib/api';
import { SearchBar } from '@/components/search-bar';
import { Pagination } from '@/components/pagination';
import { MagasinsTable } from '@/components/magasins-table';

export const metadata = { title: 'Mes magasins — Kratos' };

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const search = sp.search ?? '';
  const page = Number(sp.page ?? '1') || 1;

  let result: ClientsEnrichedResult | null = null;
  let error: string | null = null;
  try {
    result = await listClientsEnriched({ search, page });
  } catch {
    error = "Impossible de charger les magasins. L'API est-elle démarrée ?";
  }

  const mine = result?.scope?.type === 'mine';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{mine ? 'Mes magasins' : 'Magasins'}</h1>
          <p className="text-sm text-neutral-500">
            {mine
              ? `Mon portefeuille (code représentant ${result!.scope.idRepr})`
              : 'Référentiel complet des magasins.'}
          </p>
        </div>
        <SearchBar placeholder="Enseigne, raison sociale, code…" />
      </div>

      {error ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
          {error}
        </p>
      ) : (
        <>
          <MagasinsTable rows={result!.data} />
          <Pagination total={result!.total} page={result!.page} limit={result!.limit} params={{ search }} />
        </>
      )}
    </div>
  );
}
