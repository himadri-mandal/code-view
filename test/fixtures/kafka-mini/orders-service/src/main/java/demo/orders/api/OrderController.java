package demo.orders.api;

import demo.orders.domain.Order;
import demo.orders.domain.OrderService;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/orders")
public class OrderController {
  private final OrderService service;

  public OrderController(OrderService service) {
    this.service = service;
  }

  @PostMapping
  public Order create(@RequestBody OrderRequest request) {
    return service.place(request.customer(), request.items());
  }

  @GetMapping("/{id}")
  public Order get(@PathVariable Long id) {
    return service.find(id);
  }
}
