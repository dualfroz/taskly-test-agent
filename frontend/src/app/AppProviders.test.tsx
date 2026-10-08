import { QueryClient, useQueryClient } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { AppProviders } from './AppProviders'

function Probe({ expected }: { expected: QueryClient }) {
  return <p>{useQueryClient() === expected ? 'same client' : 'other client'}</p>
}

it('provides the given query client to its children', () => {
  const client = new QueryClient()
  render(
    <AppProviders client={client}>
      <Probe expected={client} />
    </AppProviders>,
  )
  expect(screen.getByText('same client')).toBeVisible()
})
