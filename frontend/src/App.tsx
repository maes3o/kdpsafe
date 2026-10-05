import type { EngineApi } from './engine/api';
import { PreflightClient } from './engine/client';
import { Header } from './components/Header';
import { Workspace } from './Workspace';

const defaultEngine = (): EngineApi => new PreflightClient();

/** `createEngine` is injectable so tests can drive the UI without a Worker. */
function App({ createEngine = defaultEngine }: { createEngine?: () => EngineApi }) {
  return (
    <div className="flex h-full min-h-screen flex-col bg-bg text-ink lg:h-screen lg:min-h-0">
      <Header />
      <main className="flex min-h-0 flex-1 flex-col">
        <Workspace createEngine={createEngine} />
      </main>
    </div>
  );
}

export default App;
