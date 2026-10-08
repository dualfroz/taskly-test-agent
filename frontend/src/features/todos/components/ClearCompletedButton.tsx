import { Trash2 } from 'lucide-react'
import { Alert, Button } from '../../../design-system'
import { useClearCompletedMutation } from '../hooks/useClearCompletedMutation'

export function ClearCompletedButton({
  count,
  busy,
  onCleared,
}: {
  count: number
  busy: boolean
  onCleared: (deleted: number) => void
}) {
  const clearCompleted = useClearCompletedMutation()
  const pending = busy || clearCompleted.isPending
  return (
    <>
      <div className="filters-action">
        <Button
          variant="secondary"
          disabled={pending || count === 0}
          onClick={() =>
            clearCompleted.mutate(undefined, {
              onSuccess: ({ deleted }) => onCleared(deleted),
            })
          }
        >
          <Trash2 size={16} aria-hidden="true" />
          Clear completed ({count})
        </Button>
      </div>
      {clearCompleted.error && (
        <div className="filters-error">
          <Alert variant="warning">{clearCompleted.error.message}</Alert>
        </div>
      )}
    </>
  )
}
