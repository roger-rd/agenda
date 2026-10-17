import type { Post, User } from '../../types';
export interface ViewProps {
  onCreate?: (day: string) => void;
  reference: string;
  posts: Post[];
  users: User[];
  onOpen: (id: string) => void;
}
