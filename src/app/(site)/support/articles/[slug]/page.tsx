import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PUBLIC_ARTICLES, publicArticleBySlug } from "@/lib/support-articles";
import { subUrl } from "@/lib/site";

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return PUBLIC_ARTICLES.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const entry = publicArticleBySlug(slug);
  if (!entry) return {};
  return {
    title: entry.article.title,
    description: entry.article.body[0],
    alternates: { canonical: subUrl("support", `/articles/${slug}`) },
  };
}

export default async function SupportArticle({ params }: Props) {
  const { slug } = await params;
  const entry = publicArticleBySlug(slug);
  if (!entry) notFound();
  const { article } = entry;
  return (
    <article className="container-z max-w-3xl pb-24 pt-40">
      <Link href={subUrl("support")} className="text-sm font-bold text-forest underline underline-offset-4">← Help center</Link>
      <p className="eyebrow mt-12">{article.category}</p>
      <h1 className="display-md mt-4">{article.title}</h1>
      <div className="mt-8 space-y-5 text-lg leading-8 text-graphite">
        {article.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
      </div>
      <Link href={subUrl("support")} className="mt-12 inline-block font-bold text-forest underline underline-offset-4">More help topics</Link>
    </article>
  );
}
