import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Images, LoaderCircle, RefreshCw, Trash2, X } from 'lucide-react';
import { browseProjectDirectory, deleteProject, listProjects } from './lib/projects';
import type { ProjectSummary } from './lib/projects';
import './project-library.css';

interface Props {
  directory: string;
  onDirectoryChange: (path: string) => void;
  disabled: boolean;
  refreshKey: number;
  onOpen: (id: string) => Promise<void>;
  onNotify: (message: string) => void;
  onBrowse?: () => Promise<void>;
}

function updatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

export default function ProjectLibrary({ directory, onDirectoryChange, disabled, refreshKey, onOpen, onNotify, onBrowse }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<{ project: ProjectSummary; directory: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [exists, setExists] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const requestRef = useRef(0);
  const deleteInFlight = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const currentDirectory = useRef(directory);
  currentDirectory.current = directory;
  const previousRef = useRef<{ directory: string; refreshKey: number; reload: number } | null>(null);
  const callbacks = useRef({ onDirectoryChange, onNotify });
  callbacks.current = { onDirectoryChange, onNotify };
  const blocked = disabled || browsing || opening !== null || deleting || deleteCandidate !== null;

  useEffect(() => { if (deleteCandidate) cancelRef.current?.focus(); }, [deleteCandidate]);

  function closeDeleteDialog() {
    if (deleteInFlight.current) return;
    setDeleteCandidate(null); setDeleteError('');
    window.requestAnimationFrame(() => deleteTriggerRef.current?.focus());
  }

  async function confirmDelete() {
    if (!deleteCandidate || deleteInFlight.current || disabled || browsing || opening !== null || loading) return;
    const candidate = deleteCandidate;
    deleteInFlight.current = true; setDeleting(true); setDeleteError('');
    dialogRef.current?.focus();
    try {
      await deleteProject(candidate.directory, candidate.project.id);
      if (currentDirectory.current === candidate.directory) setProjects(previous => previous.filter(project => project.id !== candidate.project.id));
      setDeleteCandidate(null); setReload(value => value + 1);
      onNotify(`已删除项目「${candidate.project.name}」。`);
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : '删除项目失败，请重试。');
    } finally { deleteInFlight.current = false; setDeleting(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++requestRef.current;
    const previous = previousRef.current;
    const delay = previous && previous.directory !== directory && previous.refreshKey === refreshKey && previous.reload === reload ? 600 : 0;
    previousRef.current = { directory, refreshKey, reload };
    // Clear the previous directory's cards immediately so a pending scan cannot open them.
    setProjects([]); setError(''); setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await listProjects(directory, controller.signal);
        if (controller.signal.aborted || requestId !== requestRef.current) return;
        setProjects(result.projects); setExists(result.exists);
        if (!directory.trim()) callbacks.current.onDirectoryChange('FrameAnimProjectList');
      } catch (reason) {
        if (controller.signal.aborted || requestId !== requestRef.current) return;
        setError(reason instanceof Error ? reason.message : '读取项目列表失败，请重试。');
      } finally {
        if (!controller.signal.aborted && requestId === requestRef.current) setLoading(false);
      }
    }, delay);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [directory, refreshKey, reload]);

  async function browse() {
    if (blocked || loading) return;
    setBrowsing(true);
    try {
      if (onBrowse) await onBrowse();
      else {
        const path = await browseProjectDirectory(directory);
        if (path) { onDirectoryChange(path); setReload(value => value + 1); }
      }
    } catch (reason) { onNotify(reason instanceof Error ? reason.message : '无法选择项目目录。'); }
    finally { setBrowsing(false); }
  }

  async function open(project: ProjectSummary) {
    if (blocked || loading) return;
    setOpening(project.id);
    try { await onOpen(project.id); }
    catch (reason) { onNotify(reason instanceof Error ? reason.message : '打开工程失败，请重试。'); }
    finally { setOpening(null); }
  }

  return <section className="project-library panel" aria-labelledby="project-library-heading">
    <div className="project-library-heading">
      <div className="project-library-title"><span className="project-library-icon"><FolderOpen size={19} /></span><div><h2 id="project-library-heading">帧动画项目列表</h2><p>选择项目目录，继续编辑已保存的动画。</p></div></div>
      <span className="project-library-count">{projects.length} 个项目</span>
    </div>
    <div className="project-directory-controls">
      <label className="project-directory-field"><span>项目目录</span><input aria-label="项目目录" value={directory} disabled={blocked} placeholder="FrameAnimProjectList 或自定义保存路径" spellCheck={false} onChange={event => onDirectoryChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setReload(value => value + 1); } }} /></label>
      <button className="button secondary" type="button" disabled={blocked || loading} onClick={() => void browse()}>{browsing ? <LoaderCircle className="spin" /> : <FolderOpen />}浏览目录</button>
      <button className="button secondary" type="button" disabled={blocked || loading} onClick={() => setReload(value => value + 1)}><Images />读取项目</button>
      <button className="project-refresh-button" type="button" aria-label="刷新项目列表" title="刷新列表" disabled={blocked || loading} onClick={() => setReload(value => value + 1)}><RefreshCw /></button>
    </div>
    <p className="project-directory-hint">输入路径后自动读取；相对路径以网页项目所在文件夹为起点。在页面末尾保存动画，下次选择同一目录即可继续。</p>
    {error ? <div className="project-library-message project-library-error" role="alert"><p>{error}</p><button className="button secondary" type="button" disabled={blocked || loading} onClick={() => setReload(value => value + 1)}>重新读取</button></div>
      : loading ? <div className="project-library-message" role="status"><LoaderCircle className="spin" size={17} /><span>正在读取项目列表…</span></div>
      : projects.length ? <div className="project-grid">{projects.map(project => <article className="project-card" key={project.id}>
        <div className="project-thumbnail">{project.thumbnail ? <img src={project.thumbnail} alt="" loading="lazy" /> : <Images size={25} />}</div>
        <div className="project-card-copy"><h3 title={project.name}>{project.name}</h3><p>{project.frameCount} 帧<span>·</span>{project.fps} FPS{project.selectedFrameCount !== project.frameCount && <><span>·</span>选中 {project.selectedFrameCount} 帧</>}</p><time dateTime={project.updatedAt}>{updatedAt(project.updatedAt)}</time></div>
        <div className="project-card-actions"><button className="button secondary project-open-button" type="button" disabled={blocked || loading} aria-label={`打开项目 ${project.name}`} onClick={() => void open(project)}>{opening === project.id ? <LoaderCircle className="spin" /> : <FolderOpen />}{opening === project.id ? '正在打开' : '打开项目'}</button><button className="button project-delete-button" type="button" disabled={blocked || loading} aria-label={`删除项目 ${project.name}`} onClick={event => { deleteTriggerRef.current = event.currentTarget; setDeleteError(''); setDeleteCandidate({ project, directory }); }}><Trash2 />删除项目</button></div>
      </article>)}</div>
      : <div className="project-library-message"><FolderOpen size={19} /><span>{exists ? '此目录还没有帧动画项目。完成编辑后，可在页面末尾添加。' : '此目录尚不存在。保存第一个项目时会自动创建。'}</span></div>}
    {deleteCandidate && <div className="modal-backdrop project-delete-backdrop" onClick={closeDeleteDialog} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); closeDeleteDialog(); }
      if (event.key === 'Tab') {
        const buttons = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        if (!buttons.length) { event.preventDefault(); return; }
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }}><div className="modal project-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="project-delete-title" aria-describedby="project-delete-description" tabIndex={-1} ref={dialogRef} onClick={event => event.stopPropagation()}>
      <div className="modal-heading"><h2 id="project-delete-title">确认删除项目？</h2><button className="icon-button" type="button" aria-label="关闭删除确认" disabled={deleting} onClick={closeDeleteDialog}><X size={18} /></button></div>
      <div className="modal-body"><p id="project-delete-description">确定删除项目「<strong>{deleteCandidate.project.name}</strong>」吗？</p><p className="project-delete-note">删除后将从列表移除，并保留在项目目录的 .trash 回收文件夹。</p>{deleteError && <p className="project-delete-error" role="alert">{deleteError}</p>}</div>
      <div className="modal-footer"><button ref={cancelRef} className="button secondary" type="button" disabled={deleting} onClick={closeDeleteDialog}>取消</button><button className="button project-confirm-delete" type="button" disabled={deleting || disabled || loading} onClick={() => void confirmDelete()}>{deleting ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{deleting ? '正在删除…' : '确认删除'}</button></div>
    </div></div>}
  </section>;
}
