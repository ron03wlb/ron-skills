// macOS 的 tmpdir() 是 /var/folders/...，真實路徑是 /private/var/...；被測腳本經 git 拿到的是真實路徑，
// 測試用 tmpdir() 原值比對就會誤報。暫存目錄一律從這裡取，兩邊才是同一種寫法。
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

export const realTmpdir = () => realpathSync(tmpdir());
