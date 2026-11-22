export type Author = { id: number; name: string };

export type Article = {
  id: number;
  title: string;
  author: Author;
  publishedAt: string;
};
