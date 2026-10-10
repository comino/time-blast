import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Agent worktrees live under .claude/worktrees; never collect their tests.
export default mergeConfig(viteConfig, defineConfig({
  test: { exclude: [...configDefaults.exclude, '.claude/**'] },
}));
