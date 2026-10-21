import { useNavigate } from 'react-router-dom';
import usePublicBranding from '../hooks/usePublicBranding.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { Button } from '@/components/ui/button';
import {
  Card, CardHeader, CardTitle, CardContent,
} from '@/components/ui/card';

export default function Privacy() {
  const navigate = useNavigate();
  const { loggedIn } = useAuth();
  const branding = usePublicBranding('Privacy & Data Handling');

  if (!branding) return null;

  const { primary: headerBg, foreground, logo, classroomName } = branding;

  return (
    <main className="min-h-dvh shrink-0 flex flex-col items-center justify-center p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]" style={{ backgroundColor: headerBg, color: foreground }}>
      {logo ? (
        <img src={logo} alt={classroomName} width="64" height="64" fetchPriority="high" className="h-16 w-16 mb-6 rounded-lg object-contain" />
      ) : (
        <p className="max-w-full break-words text-center text-2xl font-bold mb-6">{classroomName}</p>
      )}
      <Card className="w-full max-w-3xl">
        <CardHeader>
          <CardTitle as="h1" className="text-2xl">Privacy & Data Handling</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-sm">
          <section>
            <h2 className="text-lg font-semibold mb-2">How Your Data is Stored</h2>
            <p className="text-muted-foreground mb-2">
              This deployment runs on Google Cloud Run and stores your account and lesson data in
              PostgreSQL on Google Cloud SQL. Your data is stored separately from the app itself, so your
              saved work is kept when the app restarts or updates. Login is required to access your data.
            </p>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
              <li>
                <strong>Account information:</strong> Your name, email, and username are stored securely.
                Your password is only stored as a hash.
              </li>
              <li>
                <strong>Lesson conversations:</strong> Chat messages exchanged with the AI coach are saved
                with the lesson, so you can pause and resume without losing context.
              </li>
              <li>
                <strong>Lesson progress:</strong> Your progress and learning profile are maintained separately
                from the conversation to track your growth and adapt coaching to your needs.
              </li>
              <li>
                <strong>Uploaded images:</strong> When you paste a screenshot into a lesson, it is compressed
                and stored separately, then referenced by the conversation.
              </li>
              <li>
                <strong>Browser recovery:</strong> Sign-in tokens are stored in your browser. Unsent drafts,
                attachments, and generated replies awaiting a confirmed save are kept in this browser tab,
                so you can reload and retry saving. Keep the tab open if that storage is unavailable.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">Google Sign-In and Firebase</h2>
            <p className="text-muted-foreground mb-2">
              If you sign in with Google, plato uses Firebase Authentication to verify your sign-in,
              then creates a plato session. Your account and lesson data use the same server storage
              as password sign-ins.
            </p>
            <p className="text-muted-foreground">
              Password sign-in and password resets are handled by plato’s server. Firebase Authentication
              is used only for Google sign-in and sign-out.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">AI Provider</h2>
            <p className="text-muted-foreground mb-2">
              Your classroom admin chooses Amazon Bedrock or Cloudflare Workers AI to power the AI coach
              and other lesson features. Ask your admin which service your classroom uses.
            </p>
            <p className="text-muted-foreground">
              Your conversation messages are sent to the selected service to generate responses.
              Review Amazon’s <a
                href="https://aws.amazon.com/bedrock/data-privacy/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground"
              >Bedrock data privacy documentation</a> or Cloudflare’s <a
                href="https://developers.cloudflare.com/workers-ai/platform/data-usage/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground"
              >Workers AI data usage documentation</a> for details.
            </p>
            <p className="text-muted-foreground mt-2">
              Classroom plugins can search external websites for lesson reference material. Those sites
              receive search terms based on the lesson. Your administrator chooses which plugins are enabled.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">What Happens When You Upload Images</h2>
            <p className="text-muted-foreground mb-2">
              When you paste or upload an image during a lesson:
            </p>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
              <li>The image is compressed automatically to reduce storage size.</li>
              <li>It is stored separately and referenced by your conversation.</li>
              <li>The image is sent to the selected AI service along with your message so the AI coach can see and
                discuss what you’ve shared.</li>
              <li>Images remain accessible when you resume a lesson later.</li>
            </ul>
            <p className="text-muted-foreground mt-2">
              <strong>Be mindful of what you share.</strong> Do not upload images containing sensitive personal
              information (passwords, credit card numbers, private documents) unless you intend for them to be
              part of your learning materials.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">Data Retention</h2>
            <p className="text-muted-foreground">
              Your account, lessons, and chat history are retained as long as your account is active.
              To request deletion, contact your plato administrator.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">Administrator Access</h2>
            <p className="text-muted-foreground">
              Administrators of your plato instance may have access to user accounts, lessons, and activity for
              support and content management purposes. In some cases, administrators can view your lessons using
              a read-only “View as User” feature that is logged for audit purposes.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">Open Source & Transparency</h2>
            <p className="text-muted-foreground">
              plato is an open source project. You can review how data is handled by viewing the source code
              at <a
                href="https://github.com/1111philo/plato"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground"
              >github.com/1111philo/plato</a>.
            </p>
          </section>

          <section className="pt-4 border-t">
            <p className="text-xs text-muted-foreground">
              This page provides transparency about how plato handles data. It is not a legal privacy policy.
              If you have questions or concerns about data handling, contact your plato administrator.
            </p>
          </section>
        </CardContent>
      </Card>
      <div className="mt-4 flex gap-4 items-center text-xs" style={{ '--ring': 'currentColor' }}>
        <Button variant="link" className="text-current hover:no-underline h-auto p-0" onClick={() => navigate(loggedIn ? '/lessons' : '/login')}>
          {loggedIn ? 'Back to Lessons' : 'Back to Sign In'}
        </Button>
        <span>·</span>
        <span>
          Powered by <a href="https://github.com/1111philo/plato" target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">plato</a>.
        </span>
      </div>
    </main>
  );
}
