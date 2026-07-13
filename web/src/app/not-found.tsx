import { EmptyState } from "@/components/state";
import { Button } from "@/components/ui";

// 404 — a mistyped or dead link (shared links get mangled in chat apps all the
// time). Strings are inline, not from the copy deck, on purpose: a bad URL
// under /staff renders outside the I18nProvider (see Shell), and this page must
// never be the thing that crashes.
export default function NotFound() {
  return (
    <div className="px-4 pt-10 pb-8">
      <EmptyState
        title="This page does not exist"
        body="The link may be old or typed wrong. Your points are safe."
        action={<Button href="/" size="md" full={false}>Back to home</Button>}
      />
    </div>
  );
}
