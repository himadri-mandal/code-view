package demo.orders.domain;

import demo.orders.messaging.OrderPublisher;
import java.util.List;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;

@Service
public class OrderService {
  private final OrderRepository repository;
  private final OrderPublisher publisher;
  private final ApplicationEventPublisher events;

  public OrderService(OrderRepository repository, OrderPublisher publisher, ApplicationEventPublisher events) {
    this.repository = repository;
    this.publisher = publisher;
    this.events = events;
  }

  public Order place(String customer, List<String> items) {
    if (items.isEmpty()) {
      throw new IllegalArgumentException("empty order");
    }
    Order order = new Order();
    order.customer = customer;
    order.items = items;
    for (String item : items) {
      if (item.isBlank()) continue;
      validate(item);
    }
    Order saved = repository.save(order);
    publisher.publish(saved);
    events.publishEvent(new OrderPlaced(saved.id));
    return saved;
  }

  public Order find(Long id) {
    return repository.findById(id).orElseThrow();
  }

  private void validate(String item) {
    switch (item.length()) {
      case 0 -> throw new IllegalStateException();
      case 1, 2 -> System.out.println("short");
      default -> System.out.println("ok");
    }
  }
}
