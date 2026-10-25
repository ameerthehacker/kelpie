import { FileTextIcon, PaperclipIcon, XIcon } from 'lucide-react';
import { useCallback, useEffect, useState, type ClipboardEvent } from 'react';
import { useDropzone } from 'react-dropzone';
import type { Attachment } from '@kelpie/protocol';
import { fileSize, isImage, uploadUrl } from '@/lib/uploads';
import { cn } from '@/lib/utils';

/** As many as one message may carry (the daemon's limit). */
const MAX_FILES = 20;

/**
 * Files picked, dropped or pasted for the next message. They stay in the browser until the
 * message is sent, and are uploaded with it.
 */
export function useAttachedFiles() {
  const [files, setFiles] = useState<File[]>([]);
  const add = useCallback((more: File[]) => setFiles((now) => [...now, ...more].slice(0, MAX_FILES)), []);
  // The paperclip opens the picker; the box itself only takes drops.
  const dropzone = useDropzone({ onDrop: add, noClick: true, noKeyboard: true });
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const pasted = [...e.clipboardData.files];
      // Rich apps (spreadsheets, slides) put a picture of the text on the clipboard too: the text wins.
      if (!pasted.length || e.clipboardData.getData('text/plain')) return;
      e.preventDefault();
      add(pasted);
    },
    [add],
  );
  const remove = useCallback((file: File) => setFiles((now) => now.filter((f) => f !== file)), []);
  return { files, setFiles, remove, onPaste, dropzone };
}

function Chip({ name, detail, thumb, href, onRemove }: { name: string; detail: string; thumb?: string | undefined; href?: string | undefined; onRemove?: () => void }) {
  const body = (
    <>
      {thumb ? (
        <img src={thumb} alt="" className="size-8 shrink-0 rounded-md object-cover" />
      ) : (
        <span className="bg-raise text-mu2 flex size-8 shrink-0 items-center justify-center rounded-md">
          <FileTextIcon className="size-4" strokeWidth={1.8} />
        </span>
      )}
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="text-fg truncate text-[13px]">{name}</span>
        <span className="text-mu2 text-[11px]">{detail}</span>
      </span>
    </>
  );
  return (
    <span className="bg-chip flex max-w-56 items-center gap-2 rounded-xl py-1 pr-2 pl-1">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-2 hover:underline">
          {body}
        </a>
      ) : (
        body
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${name}`} className="text-mu2 hover:text-fg hover:bg-hov -mr-0.5 rounded-full p-0.5">
          <XIcon className="size-3.5" strokeWidth={2.2} />
        </button>
      )}
    </span>
  );
}

/** A file not sent yet, with a preview if it is an image. */
function LocalChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [thumb, setThumb] = useState<string>();
  useEffect(() => {
    if (!isImage(file.type)) return;
    const url = URL.createObjectURL(file);
    setThumb(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <Chip name={file.name} detail={fileSize(file.size)} thumb={thumb} onRemove={onRemove} />;
}

/** The files waiting to go with the next message. */
export function FileChips({ files, onRemove, className }: { files: File[]; onRemove: (f: File) => void; className?: string }) {
  if (!files.length) return null;
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {files.map((f, i) => (
        <LocalChip key={`${f.name}-${f.size}-${i}`} file={f} onRemove={() => onRemove(f)} />
      ))}
    </div>
  );
}

/**
 * Files a turn carried. Uploads (they have an id) open from the daemon, images as thumbnails;
 * files the orchestrator handed an agent show by name only.
 */
export function AttachmentChips({ sessionId, attachments, className }: { sessionId: string | undefined; attachments: Attachment[] | undefined; className?: string }) {
  if (!attachments?.length) return null;
  return (
    <div className={cn('flex flex-wrap justify-end gap-1.5', className)}>
      {attachments.map((a, i) => {
        const href = a.id && sessionId ? uploadUrl(sessionId, a.id) : undefined;
        return <Chip key={a.id ?? `${a.name}-${i}`} name={a.name} detail={fileSize(a.size)} href={href} thumb={href && isImage(a.mime) ? href : undefined} />;
      })}
    </div>
  );
}

export function AttachButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label="Attach files" title="Attach files (or drop or paste them)" className={cn('text-mu2 hover:bg-raise hover:text-fg flex size-8 shrink-0 items-center justify-center rounded-full', className)}>
      <PaperclipIcon className="size-4" strokeWidth={1.9} />
    </button>
  );
}
