# GPU burn kernel: 30s of continuous matmul on CUDA
import torch
import time

a = torch.randn(2048, 2048, device="cuda")
b = torch.randn(2048, 2048, device="cuda")
t0 = time.time()
i = 0
while time.time() - t0 < 30:
    c = a @ b
    torch.cuda.synchronize()
    i += 1
print(f"iters: {i}, avg: {(time.time() - t0) / i * 1000:.2f} ms/iter")
