export const reviewComment = `## Review summary

**2 findings** need attention. See [the linked issue](https://github.com/acme/widget/issues/42) and the \`retryRequest()\` path.

The request should preserve its original timeout budget.
This line belongs to the same paragraph.

<details>
<summary><strong>Potential timeout regression</strong> · <code>severity: medium</code></summary>

Retries currently reset the deadline instead of sharing it.

<details>
<summary>Verification and suggested fix</summary>

- [x] Reproduce with a slow upstream
- [ ] Keep the original deadline
  - Preserve cancellation between attempts

> Verify the total elapsed time, not only the attempt count.

~~~ts
const deadline = startedAt + timeout;
return retry({ deadline });
~~~

</details>
</details>

<details>
<summary>Additional review notes</summary>

| Check | Result |
| --- | --- |
| Cancellation | **Passed** |
| Retry budget | Needs a test |

</details>

Thanks for the update. ~~Old suggestion~~ Use the shared deadline.
`;
