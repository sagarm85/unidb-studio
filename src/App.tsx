import { BASE_URL, IS_CONFIGURED } from '@/lib/engine/api.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { useTheme } from '@/lib/theme.tsx';

export default function App() {
  const { theme, toggleTheme } = useTheme();
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background">
      <p className="text-sm text-text-muted">
        unidb studio v2 — scaffold booting… (configured: {String(IS_CONFIGURED)}, base: {BASE_URL || '—'})
      </p>
      <Card className="w-96">
        <CardHeader>
          <CardTitle>Phase 0 smoke test</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2">
            <Badge>neutral</Badge>
            <Badge variant="ok">ok</Badge>
            <Badge variant="warn">warn</Badge>
            <Badge variant="error">error</Badge>
          </div>
          <Input placeholder="table name" />
          <div className="flex gap-2">
            <Button onClick={toggleTheme}>Toggle theme ({theme})</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Drop table</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
