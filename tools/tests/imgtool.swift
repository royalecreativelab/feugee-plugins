// imgtool bbox <png> <r> <g> <b> [tol]     -> x0 y0 x1 y1 of pixels near the color (top-left origin)
// imgtool diff <a.png> <b.png> [tol]       -> size, mean abs diff (0-255), % pixels over tol
import Foundation
import CoreGraphics
import ImageIO

func load(_ path: String) -> (w: Int, h: Int, px: [UInt8]) {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fatalError("cannot read \(path)") }
    let w = img.width, h = img.height
    var px = [UInt8](repeating: 0, count: w * h * 4)
    let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))   // flatten on white, like AI's PNG export
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return (w, h, px)
}

let a = CommandLine.arguments
if a.count >= 6 && a[1] == "bbox" {
    let im = load(a[2]); let r = Int(a[3])!, g = Int(a[4])!, b = Int(a[5])!; let tol = a.count > 6 ? Int(a[6])! : 12
    var x0 = Int.max, y0 = Int.max, x1 = -1, y1 = -1
    for y in 0..<im.h { for x in 0..<im.w {
        let i = (y * im.w + x) * 4
        if abs(Int(im.px[i]) - r) <= tol && abs(Int(im.px[i+1]) - g) <= tol && abs(Int(im.px[i+2]) - b) <= tol {
            x0 = min(x0, x); y0 = min(y0, y); x1 = max(x1, x); y1 = max(y1, y)
        }
    }}
    print(x1 < 0 ? "none" : "\(x0) \(y0) \(x1) \(y1)  (image \(im.w)x\(im.h))")
} else if a.count >= 4 && a[1] == "diff" {
    let p = load(a[2]), q = load(a[3]); let tol = a.count > 4 ? Int(a[4])! : 40
    if p.w != q.w || p.h != q.h { print("size mismatch \(p.w)x\(p.h) vs \(q.w)x\(q.h)"); exit(2) }
    var sum = 0, over = 0
    for i in stride(from: 0, to: p.px.count, by: 4) {
        let d = max(abs(Int(p.px[i]) - Int(q.px[i])), abs(Int(p.px[i+1]) - Int(q.px[i+1])), abs(Int(p.px[i+2]) - Int(q.px[i+2])))
        sum += d; if d > tol { over += 1 }
    }
    let n = p.px.count / 4
    print(String(format: "%dx%d mean=%.2f over%d=%.3f%%", p.w, p.h, Double(sum) / Double(n), tol, 100.0 * Double(over) / Double(n)))
} else { print("usage: imgtool bbox <png> r g b [tol] | diff a b [tol]"); exit(1) }
