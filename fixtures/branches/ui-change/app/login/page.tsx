export default function LoginPage() {
  return (
    <>
      <h1>Log in</h1>
      <form method="post" action="/login">
        <label>
          Email <input type="email" name="email" required />
        </label>
        <label>
          Password <input type="password" name="password" required />
        </label>
        <button type="submit">Sign in</button>
      </form>
      <p>or</p>
      <button type="button">Continue with Google</button>
    </>
  );
}
