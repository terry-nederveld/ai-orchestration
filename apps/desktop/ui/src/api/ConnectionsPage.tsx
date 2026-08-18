import { Card } from '../components/Card'
import { ConnectionManager } from './ConnectScreen'

/** In-app runtime connection management (`/connections`). */
export function ConnectionsPage(): JSX.Element {
  return (
    <Card
      title="Runtime connections"
      subtitle="Each runtime keeps its own token and availability; the app aggregates across all of them."
    >
      <ConnectionManager />
    </Card>
  )
}
