import { useMutation, useQueryClient } from '@tanstack/react-query'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'

export function useClearCompletedMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: todoKeys.clearCompleted,
    mutationFn: () => todosApi.clearCompleted(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: todoKeys.list }),
  })
}
