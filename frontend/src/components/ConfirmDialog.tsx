import * as Dialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
}

/** Styled replacement for window.confirm() (Radix dialog, keyboard/focus safe). */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, danger, onConfirm }: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-overlay" />
        <Dialog.Content className="dlg-content">
          <Dialog.Title className="dlg-title">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="dim" style={{ marginTop: 6 }}>
              {description}
            </div>
          </Dialog.Description>
          <div className="toolbar" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
            <Dialog.Close asChild>
              <button className="btn ghost">Cancel</button>
            </Dialog.Close>
            <button
              className="btn"
              style={danger ? { background: '#7f1d1d' } : undefined}
              onClick={() => {
                onOpenChange(false)
                onConfirm()
              }}
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
