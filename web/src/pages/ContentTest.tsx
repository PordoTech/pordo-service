import { useEffect, useState, type ReactNode } from 'react'
import { api, assetUrl, errorText } from '../api'
import type {
  ChapterView,
  ComicView,
  ImagePolicy,
  PageView,
  SearchGroup,
  SourceAdminView,
} from '../types'
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Select, Spinner } from '../components/ui'

interface PagesData {
  chapter: ChapterView
  imagePolicy: ImagePolicy
  pages: PageView[]
  total: number
}

export default function ContentTest(): ReactNode {
  const [sources, setSources] = useState<SourceAdminView[]>([])
  const [sourceId, setSourceId] = useState('')
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<SearchGroup[] | null>(null)
  const [detail, setDetail] = useState<{ comic: ComicView; chapters: ChapterView[] } | null>(null)
  const [pages, setPages] = useState<PagesData | null>(null)
  const [directUrl, setDirectUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'' | 'search' | 'detail' | 'pages'>('')

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<{ sources: SourceAdminView[] }>('/api/admin/v1/sources')
        setSources(data.sources)
        if (data.sources[0]) setSourceId(data.sources[0].id)
      } catch (cause) {
        setError(errorText(cause))
      }
    })()
  }, [])

  const search = async (): Promise<void> => {
    setBusy('search')
    setError('')
    try {
      const data = await api<{ groups: SearchGroup[] }>('/api/admin/v1/test/search', {
        method: 'POST',
        body: JSON.stringify({ sourceId, q: query }),
      })
      setGroups(data.groups)
      setDetail(null)
      setPages(null)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('')
    }
  }

  const openDetail = async (comic: ComicView): Promise<void> => {
    setBusy('detail')
    setError('')
    try {
      const data = await api<{ comic: ComicView; chapters: ChapterView[] }>(
        '/api/admin/v1/test/detail',
        {
          method: 'POST',
          body: JSON.stringify({
            provider: comic.provider,
            siteId: comic.siteId,
            detailUrl: comic.detailUrl,
          }),
        },
      )
      setDetail(data)
      setPages(null)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('')
    }
  }

  const openDirectDetail = async (): Promise<void> => {
    // Accepts a bare detail URL; provider/siteId come from the selected source.
    const url = directUrl.trim()
    if (!url) return
    await openDetail({
      comicId: '',
      provider: sourceId,
      siteId: sourceId,
      siteName: sourceId,
      title: '',
      author: '',
      description: '',
      status: '',
      coverUrl: '',
      detailUrl: url,
      coverAssetId: null,
    })
  }

  const openPages = async (comic: ComicView, chapter: ChapterView): Promise<void> => {
    setBusy('pages')
    setError('')
    try {
      const data = await api<PagesData>('/api/admin/v1/test/pages', {
        method: 'POST',
        body: JSON.stringify({ comicId: comic.comicId, chapterKey: chapter.key }),
      })
      setPages(data)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold text-slate-800">内容测试</h1>
      {error && <ErrorNote error={error} />}

      <Card title="搜索探针">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="内容源">
            <Select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.displayName}（{source.id}）
                </option>
              ))}
            </Select>
          </Field>
          <div className="min-w-52 flex-1">
            <Field label="关键词">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void search()
                }}
                placeholder="例如：葬送"
              />
            </Field>
          </div>
          <Button variant="primary" disabled={busy !== '' || !query} onClick={() => void search()}>
            {busy === 'search' ? <Spinner /> : '搜索'}
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
          <div className="min-w-72 flex-1">
            <Field label="直接打开详情 URL（原始 detailUrl）">
              <Input
                value={directUrl}
                onChange={(event) => setDirectUrl(event.target.value)}
                placeholder="https://komiic.com/comic/217"
              />
            </Field>
          </div>
          <Button disabled={busy !== '' || !directUrl.trim()} onClick={() => void openDirectDetail()}>
            打开详情
          </Button>
        </div>
      </Card>

      {groups && (
        <Card title={`搜索结果（${groups.reduce((sum, group) => sum + group.books.length, 0)} 本）`}>
          <div className="space-y-4">
            {groups.map((group) => (
              <div key={group.site.siteId}>
                <p className="mb-2 text-xs font-semibold text-slate-500">
                  {group.site.siteName}（{group.site.siteId}）
                  {group.error && <span className="ml-2 text-red-600">{group.error}</span>}
                </p>
                {group.books.length === 0 && !group.error && <Empty>无结果</Empty>}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                  {group.books.map((book) => (
                    <button
                      key={book.comicId}
                      onClick={() => void openDetail(book)}
                      className="rounded-lg border border-slate-200 bg-white p-2 text-left transition-shadow hover:shadow-md"
                    >
                      {book.coverAssetId ? (
                        <img
                          src={assetUrl(book.coverAssetId)}
                          alt={book.title}
                          loading="lazy"
                          className="mb-2 aspect-[3/4] w-full rounded object-cover"
                        />
                      ) : (
                        <div className="mb-2 flex aspect-[3/4] w-full items-center justify-center rounded bg-slate-100 text-xs text-slate-400">
                          无封面
                        </div>
                      )}
                      <p className="line-clamp-2 text-xs font-medium text-slate-700">{book.title}</p>
                      <p className="mt-1 text-[10px] text-slate-400">{book.status || '—'}</p>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {detail && (
        <Card
          title={
            <span className="flex items-center gap-2">
              详情：{detail.comic.title || detail.comic.detailUrl}
              {busy === 'detail' && <Spinner />}
            </span>
          }
        >
          <div className="grid gap-4 md:grid-cols-[160px_1fr]">
            {detail.comic.coverAssetId && (
              <img
                src={assetUrl(detail.comic.coverAssetId)}
                alt={detail.comic.title}
                className="w-40 rounded-lg object-cover"
              />
            )}
            <div className="min-w-0 space-y-1 text-sm">
              <p className="text-slate-700">
                <Badge tone="indigo">{detail.comic.provider}</Badge>{' '}
                <span className="ml-1 text-xs text-slate-400">comicId {detail.comic.comicId}</span>
              </p>
              <p className="text-xs text-slate-500">
                作者：{detail.comic.author || '—'} · 状态：{detail.comic.status || '—'}
              </p>
              <p className="break-all text-xs text-slate-400">{detail.comic.detailUrl}</p>
              {detail.comic.description && (
                <p className="line-clamp-3 text-xs text-slate-500">{detail.comic.description}</p>
              )}
            </div>
          </div>
          <p className="mb-2 mt-4 text-xs font-semibold text-slate-500">
            章节（{detail.chapters.length}）
          </p>
          <div className="flex max-h-56 flex-wrap gap-2 overflow-y-auto">
            {detail.chapters.map((chapter) => (
              <button
                key={chapter.key}
                onClick={() => void openPages(detail.comic, chapter)}
                className={`rounded-lg border px-2 py-1 text-xs transition-colors ${
                  pages?.chapter.key === chapter.key
                    ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-200'
                }`}
              >
                {chapter.kind === 'volume' ? `[卷] ${chapter.name}` : chapter.name}
              </button>
            ))}
          </div>
        </Card>
      )}

      {pages && (
        <Card
          title={
            <span className="flex items-center gap-2">
              页面：{pages.chapter.name}（前 {pages.pages.length} / 共 {pages.total}）
              {busy === 'pages' && <Spinner />}
            </span>
          }
        >
          <p className="mb-3 text-xs text-slate-400">
            取图策略：并发 {pages.imagePolicy.concurrency} · 预取 {pages.imagePolicy.ahead} · 保留{' '}
            {pages.imagePolicy.behind} · 刷新保缓存 {String(pages.imagePolicy.retainCacheOnRefresh)}
          </p>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {pages.pages.map((page) => (
              <figure key={page.assetId} className="space-y-1">
                <img
                  src={assetUrl(page.assetId)}
                  alt={`第 ${page.index + 1} 页`}
                  loading="lazy"
                  className="aspect-[2/3] w-full rounded-lg border border-slate-200 object-cover"
                />
                <figcaption className="text-center text-[10px] text-slate-400">
                  #{page.index + 1}
                </figcaption>
              </figure>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}
